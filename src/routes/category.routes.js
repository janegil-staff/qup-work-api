// /qup-work-api/src/routes/category.routes.js
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listCategories, getCategory, createCategory, updateCategory, deleteCategory,
} from '../controllers/category.controller.js';

const router = Router();
const adminOnly = [requireAuth, requireRole('admin')];

// Public
router.get('/', listCategories);
router.get('/:idOrSlug', getCategory);

// Admin
router.post('/', ...adminOnly, createCategory);
router.patch('/:categoryId', ...adminOnly, updateCategory);
router.delete('/:categoryId', ...adminOnly, deleteCategory);

export default router;
