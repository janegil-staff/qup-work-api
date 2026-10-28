// /qup-work-api/src/utils/access.js
// "Who is allowed to see/change this?" — shared by many controllers.
// Things you can't access come back as 404 (not 403) so we don't reveal they exist.
import { Company, Contract, Client, Job } from '../models/index.js';
import { AppError } from './AppError.js';

export const idOf = (v) => v?._id ?? v;
export const same = (a, b) => a != null && b != null && String(idOf(a)) === String(idOf(b));

// ---------- Companies ----------
export async function getMyCompanies(req) {
  if (!req._myCompanies) {
    req._myCompanies = await Company.find({ 'members.user': req.user._id }).select(
      'name members vatRegistered'
    );
  }
  return req._myCompanies;
}

// Company ids where I'm a member (optionally only with certain roles)
export async function getMyCompanyIds(req, roles) {
  const companies = await getMyCompanies(req);
  return companies
    .filter((c) => !roles || roles.includes(c.getMemberRole(req.user._id)))
    .map((c) => c._id.toString());
}

export async function assertCompanyRole(req, companyId, roles = ['owner', 'admin', 'worker']) {
  if (!companyId) throw new AppError('company is required', 400);
  const company = await Company.findById(companyId);
  if (!company) throw AppError.notFound('Company');
  const role = company.getMemberRole(req.user._id);
  if (!role) throw AppError.notFound('Company');
  if (!roles.includes(role)) throw AppError.forbidden(`Requires company role: ${roles.join(' or ')}`);
  return company;
}

// If I'm in exactly one company, use it when none is given
export async function defaultCompanyId(req) {
  const ids = await getMyCompanyIds(req);
  return ids.length === 1 ? ids[0] : undefined;
}

// ---------- Clients ----------
export async function loadClient(req, clientId) {
  if (!clientId) throw new AppError('client is required', 400);
  const client = await Client.findById(clientId);
  if (!client) throw AppError.notFound('Client');
  if (same(client.owner, req.user._id)) return client;
  const ids = await getMyCompanyIds(req);
  if (client.company && ids.includes(String(client.company))) return client;
  throw AppError.notFound('Client');
}

// ---------- Jobs ----------
// Returns 'customer' | 'pro' | null
export async function jobSide(req, job) {
  const uid = req.user._id;
  if (same(job.customer, uid)) return 'customer';
  if (same(job.pro, uid) || (job.source === 'direct' && same(job.createdBy, uid))) return 'pro';
  if (job.company) {
    const ids = await getMyCompanyIds(req);
    if (ids.includes(String(idOf(job.company)))) return 'pro';
  }
  return null;
}

// The one who "owns" the job: the customer on marketplace jobs, the pro on direct jobs
export const isJobOwner = (job, side) =>
  (job.source === 'marketplace' && side === 'customer') || (job.source === 'direct' && side === 'pro');

// allowViewer: anyone logged in may look at open public marketplace jobs → side 'viewer'
// (sending an offer still requires the pro role, see job.routes.js)
export async function loadJob(req, jobId, { allowViewer = false } = {}) {
  if (!jobId) throw new AppError('job is required', 400);
  const job = await Job.findById(jobId);
  if (!job) throw AppError.notFound('Job');

  let side = await jobSide(req, job);
  const canView =
    allowViewer &&
    job.source === 'marketplace' &&
    job.status === 'open' &&
    (job.visibility === 'public' || job.invitedPros.some((p) => same(p, req.user._id)));
  if (!side && canView) side = 'viewer';
  if (!side) throw AppError.notFound('Job');
  return { job, side };
}

// ---------- Contracts ----------
// Returns 'customer' | 'pro' | null
export async function contractSide(req, contract) {
  const uid = req.user._id;
  if (same(contract.customer, uid)) return 'customer';
  if (same(contract.pro, uid) || contract.assignedWorkers?.some((w) => same(w, uid))) return 'pro';
  if (contract.company) {
    const ids = await getMyCompanyIds(req);
    if (ids.includes(String(idOf(contract.company)))) return 'pro';
  }
  return null;
}

export async function loadContract(req, contractId) {
  if (!contractId) throw new AppError('contract is required', 400);
  const contract = await Contract.findById(contractId);
  if (!contract) throw AppError.notFound('Contract');
  const side = await contractSide(req, contract);
  if (!side) throw AppError.notFound('Contract');
  return { contract, side };
}

export function requireActiveContract(contract) {
  if (contract.status !== 'active') throw new AppError('Contract is not active', 409);
}
