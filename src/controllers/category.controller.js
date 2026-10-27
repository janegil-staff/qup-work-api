// /qup-work-api/src/controllers/category.controller.js
import { Category } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, isObjectIdString, slugify } from '../utils/http.js';

const CATEGORY_FIELDS = [
  'name', 'slug', 'parent', 'workType', 'icon', 'description',
  'requiresCertification', 'sortOrder', 'active',
];

// GET /categories          → flat list
// GET /categories?tree=true → nested { ...category, children: [] }
export const listCategories = async (req, res) => {
  const categories = await Category.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
  if (req.query.tree !== 'true') return res.json({ categories });

  const byId = new Map(categories.map((c) => [c._id.toString(), { ...c, children: [] }]));
  const roots = [];
  for (const c of byId.values()) {
    const parent = c.parent && byId.get(c.parent.toString());
    (parent ? parent.children : roots).push(c);
  }
  res.json({ categories: roots });
};

// GET /categories/:idOrSlug
export const getCategory = async (req, res) => {
  const { idOrSlug } = req.params;
  const filter = isObjectIdString(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() };

  const category = await Category.findOne(filter);
  if (!category) throw AppError.notFound('Category');

  const children = await Category.find({ parent: category._id, active: true }).sort({
    sortOrder: 1,
    name: 1,
  });
  res.json({ category, children });
};

// POST /categories (admin)
export const createCategory = async (req, res) => {
  const data = pick(req.body, CATEGORY_FIELDS);
  data.slug = slugify(data.slug || data.name);
  const category = await Category.create(data);
  res.status(201).json({ category });
};

// PATCH /categories/:categoryId (admin)
export const updateCategory = async (req, res) => {
  const category = await Category.findById(req.params.categoryId);
  if (!category) throw AppError.notFound('Category');

  const data = pick(req.body, CATEGORY_FIELDS);
  if (data.slug) data.slug = slugify(data.slug);
  category.set(data);
  await category.save();
  res.json({ category });
};

// DELETE /categories/:categoryId (admin) → deactivates (jobs may still point to it)
export const deleteCategory = async (req, res) => {
  const category = await Category.findById(req.params.categoryId);
  if (!category) throw AppError.notFound('Category');
  category.active = false;
  await category.save();
  res.status(204).end();
};
