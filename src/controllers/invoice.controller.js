// /qup-work-api/src/controllers/invoice.controller.js
// Invoices are created as drafts. The invoice number + KID are assigned when it is SENT,
// so issued invoices are numbered without gaps.
import { Invoice, Company, Contract, Client, User, TimeEntry } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate, addDays } from '../utils/http.js';
import { assertCompanyRole, getMyCompanyIds, loadContract, same } from '../utils/access.js';
import { notify } from '../utils/notify.js';

const LINE_FIELDS = ['description', 'quantity', 'unit', 'unitPrice', 'vatRate'];

// KID with MOD10 (Luhn) check digit, as Norwegian banks expect
function kidFor(number) {
  const base = String(number).padStart(6, '0');
  let sum = 0;
  let double = true;
  for (let i = base.length - 1; i >= 0; i--) {
    let d = Number(base[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return base + ((10 - (sum % 10)) % 10);
}

// Companies that are not VAT registered can't charge VAT
function cleanLines(lines, company) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => {
    const line = pick(l, LINE_FIELDS);
    line.vatRate = company.vatRegistered ? line.vatRate ?? 25 : 0;
    return line;
  });
}

// Who gets the invoice: from a client, or from a contract's client/customer
async function resolveRecipient(req, body, companyId) {
  let contract;
  if (body.contract) {
    contract = await Contract.findById(body.contract);
    if (!contract || !same(contract.company, companyId)) {
      throw new AppError('That contract does not belong to this company', 400);
    }
  }

  const clientId = body.client ?? contract?.client;
  let client;
  let customer;
  if (clientId) {
    client = await Client.findById(clientId);
    if (!client || !(same(client.company, companyId) || same(client.owner, req.user._id))) {
      throw new AppError('Client not found in this company', 400);
    }
  } else if (contract?.customer) {
    customer = await User.findById(contract.customer).select('name email address');
  }

  const billTo =
    body.billTo ??
    (client
      ? { name: client.name, orgNumber: client.orgNumber, email: client.email, address: client.address?.toObject() }
      : customer
        ? { name: customer.name, email: customer.email, address: customer.address?.toObject() }
        : null);
  if (!billTo?.name) throw new AppError('Invoice needs a client, a contract or billTo.name', 400);

  return { contract, client, customer, billTo };
}

async function loadInvoice(req, invoiceId, { write = false } = {}) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice');

  // The customer can read invoices sent to them
  if (!write && same(invoice.customer, req.user._id) && invoice.status !== 'draft') {
    return { invoice, role: 'customer' };
  }
  await assertCompanyRole(req, invoice.company, ['owner', 'admin']);
  return { invoice, role: 'company' };
}

const requireDraft = (invoice) => {
  if (invoice.status !== 'draft') throw new AppError('Only draft invoices can be changed', 409);
};

// GET /invoices?role=company|customer&company=&client=&status=
export const listInvoices = async (req, res) => {
  let filter;
  if (req.query.role === 'customer') {
    filter = { customer: req.user._id, status: { $ne: 'draft' } };
  } else {
    let ids = await getMyCompanyIds(req, ['owner', 'admin']);
    if (req.query.company) {
      if (!ids.includes(String(req.query.company))) throw AppError.forbidden();
      ids = [String(req.query.company)];
    }
    filter = { company: { $in: ids } };
    if (req.query.client) filter.client = req.query.client;
  }
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };

  res.json(
    await paginate(Invoice, filter, getPagination(req.query), {
      populate: [
        { path: 'client', select: 'name' },
        { path: 'company', select: 'name' },
      ],
    })
  );
};

// POST /invoices  { company, client | contract | billTo, lines, issueDate, dueDate, notes }
export const createInvoice = async (req, res) => {
  const body = req.body ?? {};
  const company = await assertCompanyRole(req, body.company, ['owner', 'admin']);
  const { contract, client, customer, billTo } = await resolveRecipient(req, body, company._id);

  const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
  const invoice = await Invoice.create({
    company: company._id,
    createdBy: req.user._id,
    client: client?._id,
    customer: customer?._id,
    contract: contract?._id,
    billTo,
    lines: cleanLines(body.lines, company),
    issueDate,
    dueDate: body.dueDate ? new Date(body.dueDate) : addDays(issueDate, company.invoiceSettings?.paymentTermsDays ?? 14),
    notes: body.notes,
  });
  res.status(201).json({ invoice });
};

// POST /invoices/from-time  { contract, extraLines: [...] }
// Turns all billable, not-yet-invoiced hours on a contract into an invoice draft.
export const createInvoiceFromTime = async (req, res) => {
  const body = req.body ?? {};
  const { contract, side } = await loadContract(req, body.contract);
  if (side !== 'pro' || !contract.company) {
    throw new AppError('The contract must belong to one of your companies', 400);
  }
  if (!contract.hourlyRate) throw new AppError('This contract has no hourly rate', 400);
  const company = await assertCompanyRole(req, contract.company, ['owner', 'admin']);

  const entries = await TimeEntry.find({
    contract: contract._id,
    running: false,
    billable: true,
    invoice: null,
  });
  if (!entries.length) throw new AppError('No billable, uninvoiced hours on this contract', 409);

  const minutes = entries.reduce((s, e) => s + (e.minutes ?? 0), 0);
  const hours = Math.round((minutes / 60) * 100) / 100;
  const vatRate = company.vatRegistered ? contract.vatRate : 0;
  // Contract rates include VAT; invoice lines are excl. VAT
  const unitPrice = Math.round((contract.hourlyRate * 100) / (100 + vatRate));

  const { client, customer, billTo } = await resolveRecipient(req, { contract: contract._id }, company._id);
  const issueDate = new Date();

  const invoice = await Invoice.create({
    company: company._id,
    createdBy: req.user._id,
    client: client?._id,
    customer: customer?._id,
    contract: contract._id,
    billTo,
    lines: [
      {
        description: `Arbeid: ${contract.title}`,
        quantity: hours,
        unit: 'timer',
        unitPrice,
        vatRate,
        timeEntries: entries.map((e) => e._id),
      },
      ...cleanLines(body.extraLines, company), // materials etc.
    ],
    issueDate,
    dueDate: addDays(issueDate, company.invoiceSettings?.paymentTermsDays ?? 14),
  });

  await TimeEntry.updateMany({ _id: { $in: entries.map((e) => e._id) } }, { invoice: invoice._id });
  res.status(201).json({ invoice, hours });
};

// GET /invoices/:invoiceId
export const getInvoice = async (req, res) => {
  const { invoice, role } = await loadInvoice(req, req.params.invoiceId);
  await invoice.populate([
    { path: 'company', select: 'name orgNumber vatRegistered address email phone logoUrl invoiceSettings.bankAccount invoiceSettings.footerText' },
    { path: 'client', select: 'name' },
    { path: 'contract', select: 'title' },
  ]);
  res.json({ invoice, role });
};

// PATCH /invoices/:invoiceId (drafts only)
export const updateInvoice = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  requireDraft(invoice);

  const data = pick(req.body, ['issueDate', 'dueDate', 'notes', 'billTo']);
  if (req.body?.lines) {
    const company = await Company.findById(invoice.company).select('vatRegistered');
    // Keep the time-entry links on existing lines
    const oldLinks = new Map(invoice.lines.map((l) => [String(l._id), l.timeEntries]));
    data.lines = cleanLines(req.body.lines, company).map((l, i) => {
      const id = req.body.lines[i]?._id;
      return id ? { ...l, _id: id, timeEntries: oldLinks.get(String(id)) ?? [] } : l;
    });
  }
  invoice.set(data);
  await invoice.save();
  res.json({ invoice });
};

// POST /invoices/:invoiceId/send → assigns number + KID
export const sendInvoice = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  requireDraft(invoice);

  const company = await Company.findOneAndUpdate(
    { _id: invoice.company },
    { $inc: { 'invoiceSettings.nextInvoiceNumber': 1 } },
    { new: false, projection: { invoiceSettings: 1 } }
  );
  const number = company.invoiceSettings?.nextInvoiceNumber ?? 1;

  invoice.set({ number, kid: kidFor(number), status: 'sent', sentAt: new Date() });
  await invoice.save();
  // TODO (email step): generate PDF and email it to billTo.email

  await notify(invoice.customer, 'invoice_received', `Ny faktura #${number}`, invoice.billTo.name, {
    invoiceId: invoice._id,
  });
  res.json({ invoice });
};

// POST /invoices/:invoiceId/mark-paid  { paidAt }
export const markInvoicePaid = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  if (!['sent', 'overdue'].includes(invoice.status)) {
    throw new AppError('Only sent invoices can be marked as paid', 409);
  }
  invoice.set({ status: 'paid', paidAt: req.body?.paidAt ? new Date(req.body.paidAt) : new Date() });
  await invoice.save();
  res.json({ invoice });
};

// DELETE /invoices/:invoiceId → only drafts (sent invoices need a credit note)
export const deleteInvoice = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  if (invoice.status !== 'draft') {
    throw new AppError('Sent invoices cannot be deleted, they must be credited', 409);
  }
  await TimeEntry.updateMany({ invoice: invoice._id }, { $unset: { invoice: 1 } });
  await invoice.deleteOne();
  res.status(204).end();
};
