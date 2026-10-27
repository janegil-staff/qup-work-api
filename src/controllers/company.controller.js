// /qup-work-api/src/controllers/company.controller.js
import { Company, User, ProProfile } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, setNested } from '../utils/http.js';
import { assertCompanyRole } from '../utils/access.js';

const COMPANY_FIELDS = [
  'name', 'orgNumber', 'orgForm', 'vatRegistered', 'email', 'phone', 'website', 'logoUrl', 'address',
];
const INVOICE_SETTINGS = ['paymentTermsDays', 'bankAccount', 'footerText', 'nextInvoiceNumber'];
const memberPopulate = { path: 'members.user', select: 'name email avatarUrl phone' };

// POST /companies
export const createCompany = async (req, res) => {
  const uid = req.user._id;
  const company = new Company({
    ...pick(req.body, COMPANY_FIELDS),
    owner: uid,
    members: [{ user: uid, role: 'owner' }],
  });
  setNested(company, 'invoiceSettings', req.body?.invoiceSettings, INVOICE_SETTINGS);
  await company.save();

  // Owning a company makes you a pro; link an existing pro profile without a company
  await User.updateOne({ _id: uid }, { $addToSet: { roles: 'pro' } });
  await ProProfile.updateOne(
    { user: uid, company: { $exists: false } },
    { $set: { company: company._id } }
  );

  res.status(201).json({ company });
};

// GET /companies
export const listMyCompanies = async (req, res) => {
  const companies = await Company.find({ 'members.user': req.user._id }).sort({ name: 1 });
  res.json({
    companies: companies.map((c) => ({ ...c.toJSON(), myRole: c.getMemberRole(req.user._id) })),
  });
};

// GET /companies/:companyId
export const getCompany = async (req, res) => {
  const company = await assertCompanyRole(req, req.params.companyId);
  const myRole = company.getMemberRole(req.user._id);
  await company.populate(memberPopulate);
  res.json({ company, myRole });
};

// PATCH /companies/:companyId
export const updateCompany = async (req, res) => {
  const company = await assertCompanyRole(req, req.params.companyId, ['owner', 'admin']);
  company.set(pick(req.body, COMPANY_FIELDS));
  setNested(company, 'invoiceSettings', req.body?.invoiceSettings, INVOICE_SETTINGS);
  await company.save();
  res.json({ company });
};

// POST /companies/:companyId/members  { email, role, hourlyCost }
export const addMember = async (req, res) => {
  const company = await assertCompanyRole(req, req.params.companyId, ['owner', 'admin']);
  const { email, role = 'worker', hourlyCost } = req.body ?? {};

  if (!['admin', 'worker'].includes(role)) throw new AppError('role must be admin or worker', 400);
  if (role === 'admin' && company.getMemberRole(req.user._id) !== 'owner') {
    throw AppError.forbidden('Only the owner can add admins');
  }

  const user = await User.findOne({ email: String(email ?? '').toLowerCase().trim() });
  if (!user) throw AppError.notFound('User with that email');
  if (company.getMemberRole(user._id)) throw new AppError('User is already a member', 409);

  company.members.push({ user: user._id, role, hourlyCost });
  await company.save();
  await User.updateOne({ _id: user._id }, { $addToSet: { roles: 'pro' } });

  await company.populate(memberPopulate);
  res.status(201).json({ company });
};

// PATCH /companies/:companyId/members/:userId  { role, hourlyCost }
export const updateMember = async (req, res) => {
  const company = await assertCompanyRole(req, req.params.companyId, ['owner', 'admin']);
  const myRole = company.getMemberRole(req.user._id);
  const member = company.members.find((m) => String(m.user) === req.params.userId);
  if (!member) throw AppError.notFound('Member');

  const { role, hourlyCost } = req.body ?? {};
  if (role !== undefined) {
    if (member.role === 'owner') throw new AppError("The owner's role cannot be changed", 400);
    if (!['admin', 'worker'].includes(role)) throw new AppError('role must be admin or worker', 400);
    if ((role === 'admin' || member.role === 'admin') && myRole !== 'owner') {
      throw AppError.forbidden('Only the owner can change admins');
    }
    member.role = role;
  }
  if (hourlyCost !== undefined) member.hourlyCost = hourlyCost;

  await company.save();
  await company.populate(memberPopulate);
  res.json({ company });
};

// DELETE /companies/:companyId/members/:userId  (also used to leave a company)
export const removeMember = async (req, res) => {
  const company = await assertCompanyRole(req, req.params.companyId);
  const myRole = company.getMemberRole(req.user._id);
  const targetId = req.params.userId;
  const isSelf = targetId === req.user._id.toString();

  if (!isSelf && !['owner', 'admin'].includes(myRole)) throw AppError.forbidden();

  const target = company.members.find((m) => String(m.user) === targetId);
  if (!target) throw AppError.notFound('Member');
  if (target.role === 'owner') throw new AppError('The owner cannot be removed', 400);
  if (target.role === 'admin' && !isSelf && myRole !== 'owner') {
    throw AppError.forbidden('Only the owner can remove admins');
  }

  company.members = company.members.filter((m) => String(m.user) !== targetId);
  await company.save();
  res.status(204).end();
};
