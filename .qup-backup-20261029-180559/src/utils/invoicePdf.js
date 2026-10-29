// /qup-work-api/src/utils/invoicePdf.js
// Builds the invoice as an A4 PDF (pdf-lib, no native parts). Norwegian by default,
// English with lang: 'en'. Drafts get an "UTKAST"/"DRAFT" watermark.
//   const bytes = await buildInvoicePdf(invoice, company, { lang: 'nb' });
// `company` is the full Company document (name, orgNumber, address, invoiceSettings, logoUrl).
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const A4 = [595.28, 841.89];
const M = 48; // page margin
const INK = rgb(0.114, 0.165, 0.18); // slate #1D2A2E
const MUTED = rgb(0.357, 0.408, 0.42);
const LINE = rgb(0.84, 0.86, 0.84);
const HIVIS_SOFT = rgb(1, 0.953, 0.769);

const TEXT = {
  nb: {
    invoice: 'FAKTURA', draft: 'UTKAST', number: 'Fakturanr.', date: 'Fakturadato', due: 'Forfallsdato', kid: 'KID',
    to: 'Faktura til', description: 'Beskrivelse', qty: 'Antall', price: 'Pris', vat: 'MVA', amount: 'Beløp',
    subtotal: 'Sum eks. mva', vatLine: (r) => `MVA ${r} %`, total: 'Å betale', notVat: 'Ikke mva-registrert',
    howToPay: 'Betaling', account: 'Kontonummer', orgNr: 'Org.nr.', registry: 'Foretaksregisteret', made: 'Laget med Qup Work',
    page: (n, of) => `Side ${n} av ${of}`, paid: 'BETALT',
    units: { stk: 'stk', timer: 'timer', m: 'm', m2: 'm²', km: 'km', pakke: 'pakke' },
  },
  en: {
    invoice: 'INVOICE', draft: 'DRAFT', number: 'Invoice no.', date: 'Invoice date', due: 'Due date', kid: 'KID',
    to: 'Bill to', description: 'Description', qty: 'Qty', price: 'Price', vat: 'VAT', amount: 'Amount',
    subtotal: 'Subtotal excl. VAT', vatLine: (r) => `VAT ${r} %`, total: 'Amount due', notVat: 'Not VAT registered',
    howToPay: 'Payment', account: 'Account number', orgNr: 'Org. no.', registry: 'Foretaksregisteret', made: 'Made with Qup Work',
    page: (n, of) => `Page ${n} of ${of}`, paid: 'PAID',
    units: { stk: 'pcs', timer: 'hours', m: 'm', m2: 'm²', km: 'km', pakke: 'pack' },
  },
};

export const invoiceLang = (lang) => (lang === 'en' ? 'en' : 'nb');

// 125000 øre → "1 250,00"
function money(ore) {
  const neg = ore < 0;
  const abs = Math.abs(Math.round(ore ?? 0));
  const kr = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}${kr},${String(abs % 100).padStart(2, '0')}`;
}

const qty = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace('.', ','));
const day = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`;
};
const orgNo = (n) => String(n ?? '').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
const account = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : n;
};

export function invoiceFileName(invoice, lang = 'nb') {
  const word = invoiceLang(lang) === 'en' ? 'Invoice' : 'Faktura';
  return `${word}-${invoice.number ?? 'utkast'}.pdf`;
}

// Letters that don't simplify by dropping the accent
const SPECIAL = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', '✓': 'v' };

// The standard fonts only cover Western European letters (æøå are fine).
// Anything else (ł, ő, Cyrillic, emoji) is swapped for something they can draw.
function safe(font, text) {
  const s = String(text ?? '')
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/−/g, '-')
    .replace(/\s+/g, ' ');
  let out = '';
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      const plain = SPECIAL[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      try {
        font.encodeText(plain);
        out += plain;
      } catch {
        out += '?';
      }
    }
  }
  return out;
}

// Splits text into lines that fit `width`
function wrap(font, size, text, width) {
  const words = safe(font, text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = w;
      // a single word longer than the column is cut
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

async function fetchLogo(url) {
  if (!url) return null;
  try {
    // Cloudinary can hand it to us as a small PNG whatever was uploaded
    const src = url.includes('res.cloudinary.com') && url.includes('/upload/')
      ? url.replace('/upload/', '/upload/c_limit,w_360,h_360,f_png/')
      : url;
    const res = await fetch(src, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
}

export async function buildInvoicePdf(invoice, company, { lang = 'nb' } = {}) {
  const L = TEXT[invoiceLang(lang)];
  const doc = await PDFDocument.create();
  doc.setTitle(`${L.invoice} ${invoice.number ?? ''}`.trim());
  doc.setAuthor(company?.name ?? '');
  doc.setCreator('Qup Work');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const draft = invoice.status === 'draft';
  const vatRegistered = Boolean(company?.vatRegistered);
  const settings = company?.invoiceSettings ?? {};

  const pages = [];
  let page;
  let y;
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    y = A4[1] - M;
  };
  const text = (s, x, yy, { f = font, size = 10, color = INK, right = false } = {}) => {
    const str = safe(f, s);
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: right ? x - w : x, y: yy, size, font: f, color });
    return w;
  };
  const hr = (yy, color = LINE, thickness = 0.7) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: A4[0] - M, y: yy }, thickness, color });

  newPage();
  const right = A4[0] - M;

  // ---------- Header: the company on the left, INVOICE + facts on the right
  const logo = await fetchLogo(company?.logoUrl);
  let left = M;
  if (logo) {
    try {
      const img = logo.type.includes('jp') ? await doc.embedJpg(logo.bytes) : await doc.embedPng(logo.bytes);
      const scale = Math.min(56 / img.width, 56 / img.height);
      page.drawImage(img, { x: M, y: y - img.height * scale + 6, width: img.width * scale, height: img.height * scale });
      left = M + img.width * scale + 12;
    } catch {
      // unreadable logo: carry on without it
    }
  }
  text(company?.name ?? '', left, y - 8, { f: bold, size: 15 });
  const fromLines = [
    company?.orgNumber && `${L.orgNr} ${orgNo(company.orgNumber)}${vatRegistered ? ' MVA' : ''}`,
    company?.orgForm === 'AS' && L.registry,
    company?.address?.line1,
    [company?.address?.postalCode, company?.address?.city].filter(Boolean).join(' '),
    company?.email,
    company?.phone,
  ].filter(Boolean);
  let fy = y - 24;
  for (const l of fromLines) {
    text(l, left, fy, { size: 9, color: MUTED });
    fy -= 12;
  }

  text(draft ? `${L.invoice} (${L.draft})` : L.invoice, right, y - 12, { f: bold, size: 22, right: true });
  const facts = [
    invoice.number && [L.number, String(invoice.number)],
    [L.date, day(invoice.issueDate)],
    [L.due, day(invoice.dueDate)],
    invoice.kid && [L.kid, invoice.kid],
  ].filter(Boolean);
  let ry = y - 34;
  for (const [k, v] of facts) {
    text(k, right - 150, ry, { size: 9, color: MUTED });
    text(v, right, ry, { f: bold, size: 9.5, right: true });
    ry -= 14;
  }

  y = Math.min(fy, ry) - 22;

  // ---------- Bill to
  text(L.to.toUpperCase(), M, y, { f: bold, size: 8, color: MUTED });
  y -= 15;
  const b = invoice.billTo ?? {};
  text(b.name ?? '', M, y, { f: bold, size: 11 });
  y -= 13;
  for (const l of [
    b.orgNumber && `${L.orgNr} ${orgNo(b.orgNumber)}`,
    b.address?.line1,
    b.address?.line2,
    [b.address?.postalCode, b.address?.city].filter(Boolean).join(' '),
  ].filter(Boolean)) {
    text(l, M, y, { size: 9.5 });
    y -= 12;
  }
  y -= 18;

  // ---------- Lines
  const cols = vatRegistered
    ? { desc: M, qty: right - 240, price: right - 140, vat: right - 82, amount: right }
    : { desc: M, qty: right - 190, price: right - 90, vat: null, amount: right };
  const descWidth = cols.qty - 60 - cols.desc;
  const header = () => {
    text(L.description, cols.desc, y, { f: bold, size: 8.5, color: MUTED });
    text(L.qty, cols.qty, y, { f: bold, size: 8.5, color: MUTED, right: true });
    text(L.price, cols.price, y, { f: bold, size: 8.5, color: MUTED, right: true });
    if (cols.vat) text(L.vat, cols.vat, y, { f: bold, size: 8.5, color: MUTED, right: true });
    text(L.amount, cols.amount, y, { f: bold, size: 8.5, color: MUTED, right: true });
    y -= 7;
    hr(y, INK, 1);
    y -= 15;
  };
  header();

  for (const line of invoice.lines ?? []) {
    const rows = wrap(font, 9.5, line.description, descWidth);
    const height = rows.length * 12 + 10;
    if (y - height < M + 60) {
      newPage();
      header();
    }
    rows.forEach((r, i) => text(r, cols.desc, y - i * 12, { size: 9.5 }));
    text(`${qty(line.quantity)} ${L.units[line.unit] ?? line.unit ?? ''}`, cols.qty, y, { size: 9.5, right: true });
    text(money(line.unitPrice), cols.price, y, { size: 9.5, right: true });
    if (cols.vat) text(`${line.vatRate ?? 0} %`, cols.vat, y, { size: 9.5, right: true });
    text(money(line.amount), cols.amount, y, { size: 9.5, right: true });
    y -= rows.length * 12 + 4;
    hr(y);
    y -= 14;
  }

  // ---------- Totals (VAT split per rate, as the rules want)
  const byRate = new Map();
  for (const line of invoice.lines ?? []) {
    if (!line.vatAmount) continue;
    byRate.set(line.vatRate, (byRate.get(line.vatRate) ?? 0) + line.vatAmount);
  }
  const totalRows = [[L.subtotal, money(invoice.subtotal)]];
  if (vatRegistered) for (const [rate, amount] of [...byRate].sort((a, c) => c[0] - a[0])) totalRows.push([L.vatLine(rate), money(amount)]);
  else totalRows.push([L.notVat, '']);
  if (y - (totalRows.length * 14 + 120) < M) newPage();

  y -= 4;
  for (const [k, v] of totalRows) {
    text(k, right - 190, y, { size: 9.5, color: MUTED });
    text(v, right, y, { size: 9.5, right: true });
    y -= 14;
  }
  y -= 2;
  page.drawLine({ start: { x: right - 190, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 1.5, color: INK });
  y -= 8;
  text(L.total, right - 190, y, { f: bold, size: 12 });
  text(`kr ${money(invoice.total)}`, right, y, { f: bold, size: 12, right: true });
  y -= 30;

  // ---------- How to pay
  if (!draft && invoice.status !== 'paid' && (settings.bankAccount || invoice.kid)) {
    const rows = [
      settings.bankAccount && [L.account, account(settings.bankAccount)],
      invoice.kid && [L.kid, invoice.kid],
      [L.amount, `kr ${money(invoice.total)}`],
      [L.due, day(invoice.dueDate)],
    ].filter(Boolean);
    const boxH = rows.length * 15 + 30;
    if (y - boxH < M) newPage();
    page.drawRectangle({ x: M, y: y - boxH + 12, width: A4[0] - 2 * M, height: boxH, color: HIVIS_SOFT });
    text(L.howToPay.toUpperCase(), M + 14, y - 4, { f: bold, size: 8, color: MUTED });
    let py = y - 22;
    for (const [k, v] of rows) {
      text(k, M + 14, py, { size: 10 });
      text(v, M + 150, py, { f: bold, size: 10.5 });
      py -= 15;
    }
    y -= boxH + 10;
  }

  // ---------- Notes and footer text
  for (const block of [invoice.notes, settings.footerText].filter(Boolean)) {
    for (const r of wrap(font, 9, block, A4[0] - 2 * M)) {
      if (y < M + 24) newPage();
      text(r, M, y, { size: 9, color: MUTED });
      y -= 12;
    }
    y -= 8;
  }

  // ---------- On every page: footer, page numbers, and the watermark on drafts / paid
  pages.forEach((p, i) => {
    page = p;
    hr(M - 6);
    text(L.made, M, M - 20, { size: 7.5, color: MUTED });
    if (pages.length > 1) text(L.page(i + 1, pages.length), right, M - 20, { size: 7.5, color: MUTED, right: true });
    const stamp = draft ? L.draft : invoice.status === 'paid' ? L.paid : null;
    if (stamp) {
      p.drawText(stamp, {
        x: 150,
        y: 300,
        size: 96,
        font: bold,
        color: draft ? rgb(0.75, 0.75, 0.75) : rgb(0.18, 0.42, 0.31),
        opacity: 0.18,
        rotate: degrees(35),
      });
    }
  });

  return doc.save();
}
