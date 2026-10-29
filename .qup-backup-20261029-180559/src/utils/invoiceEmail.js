// /qup-work-api/src/utils/invoiceEmail.js
// Emails an invoice as a PDF to the recipient, and notes on the invoice what happened.
//   const result = await emailInvoice(invoice, company, { to, lang })
//   → { sent, to, saved?, error? }   never throws: the invoice is sent either way
import { buildInvoicePdf, invoiceFileName, invoiceLang } from './invoicePdf.js';
import { sendMail } from './mailer.js';

const EMAIL = /^\S+@\S+\.\S+$/;

const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(ore) {
  const abs = Math.abs(Math.round(ore ?? 0));
  const kr = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `kr ${kr},${String(abs % 100).padStart(2, '0')}`;
}
const day = (d) => {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`;
};
const account = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : n;
};

const COPY = {
  nb: {
    subject: (i, c) => `Faktura ${i.number} fra ${c.name}`,
    hello: (name) => `Hei ${name},`,
    intro: (i, c) => `Her er faktura nr. ${i.number} fra ${c.name}. Fakturaen ligger vedlagt som PDF.`,
    amount: 'Beløp', due: 'Forfall', account: 'Kontonummer', kid: 'KID',
    kidNote: 'Husk å bruke KID-nummeret når du betaler.',
    questions: (c) => `Spørsmål om fakturaen? Svar på denne e-posten, så kommer den fram til ${c.name}.`,
    sentWith: 'Sendt med Qup Work',
  },
  en: {
    subject: (i, c) => `Invoice ${i.number} from ${c.name}`,
    hello: (name) => `Hi ${name},`,
    intro: (i, c) => `Here is invoice no. ${i.number} from ${c.name}. The invoice is attached as a PDF.`,
    amount: 'Amount', due: 'Due date', account: 'Account number', kid: 'KID',
    kidNote: 'Please use the KID number when you pay.',
    questions: (c) => `Questions about the invoice? Reply to this email and it reaches ${c.name}.`,
    sentWith: 'Sent with Qup Work',
  },
};

function compose(invoice, company, lang) {
  const C = COPY[invoiceLang(lang)];
  const bank = company.invoiceSettings?.bankAccount;
  const rows = [
    [C.amount, money(invoice.total)],
    [C.due, day(invoice.dueDate)],
    bank && [C.account, account(bank)],
    invoice.kid && [C.kid, invoice.kid],
  ].filter(Boolean);

  const text = [
    C.hello(invoice.billTo.name),
    '',
    C.intro(invoice, company),
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(invoice.kid ? ['', C.kidNote] : []),
    '',
    C.questions(company),
    '',
    company.name,
    ...[company.email, company.phone].filter(Boolean),
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ECEEEA;font-family:Helvetica,Arial,sans-serif;color:#1D2A2E">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 28px;background:#1D2A2E;border-radius:8px 8px 0 0;color:#F3F5F2;font-size:18px;font-weight:bold">${escape(company.name)}</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 12px">${escape(C.hello(invoice.billTo.name))}</p>
<p style="margin:0 0 20px;line-height:1.5">${escape(C.intro(invoice, company))}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF3C4;border-radius:6px">
${rows.map(([k, v]) => `<tr><td style="padding:8px 16px;color:#5B686B;font-size:14px">${escape(k)}</td><td style="padding:8px 16px;font-weight:bold;text-align:right;font-size:15px">${escape(v)}</td></tr>`).join('\n')}
</table>
${invoice.kid ? `<p style="margin:16px 0 0;font-size:14px;color:#5B686B">${escape(C.kidNote)}</p>` : ''}
<p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#5B686B">${escape(C.questions(company))}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #D6DBD6;font-size:12px;color:#5B686B">${escape(C.sentWith)}</td></tr>
</table></body></html>`;

  return { subject: C.subject(invoice, company), text, html };
}

export async function emailInvoice(invoice, company, { to, lang = 'nb' } = {}) {
  const address = String(to ?? invoice.billTo?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(address)) return { sent: false, to: null, error: 'no_email' };

  try {
    const pdf = await buildInvoicePdf(invoice, company, { lang });
    const { subject, text, html } = compose(invoice, company, lang);
    const result = await sendMail({
      to: address,
      subject,
      text,
      html,
      replyTo: company.email || undefined,
      attachments: [{ filename: invoiceFileName(invoice, lang), content: pdf }],
    });
    // Saved locally (no email key) counts as not sent, so the app can say so
    if (result.sent) invoice.set({ emailedAt: new Date(), emailedTo: address, emailError: undefined });
    else invoice.set({ emailError: undefined });
    await invoice.save();
    return { sent: result.sent, to: address, saved: result.saved };
  } catch (err) {
    invoice.set({ emailError: err.message });
    await invoice.save().catch(() => {});
    console.error('invoice email failed:', err.message);
    return { sent: false, to: address, error: err.message };
  }
}
