import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedProductLabelCategories,
  pagedProductLabels,
  pagedProductParamTemplates,
  pagedProductProtections,
  productLabel,
  productLabelCategory,
  productLabelCategoryExample,
  productLabelCategoryForm,
  productLabelCategoryListQuery,
  productLabelEnabledBody,
  productLabelExample,
  productLabelForm,
  productLabelListQuery,
  productParamTemplate,
  productParamTemplateEnabledBody,
  productParamTemplateExample,
  productParamTemplateForm,
  productParamTemplateListQuery,
  productProtection,
  productProtectionEnabledBody,
  productProtectionExample,
  productProtectionForm,
  productProtectionListQuery,
} from './schemas';

/**
 * The shop's vocabulary: labels, label categories, parameter templates and
 * protection badges. Four small CRUDs with the same shape.
 *
 * **Protections get their own permission atoms.** Sharing the parameters' atoms
 * would mean a role granted "product parameters" silently also granted "edit
 * the guarantee badges shown on every product page".
 */

const rowParams = z.object({ id });

// ---------------------------------------------------------------------------
// label categories
// ---------------------------------------------------------------------------

export const catalogAdminLabelCategoryList = defineRoute({
  id: 'catalog.adminLabelCategoryList',
  method: 'GET',
  path: '/admin-api/catalog/label-categories',
  auth: 'admin',
  permission: 'catalog:label:read',
  summary: '标签分类列表',
  tags: ['catalog'],
  query: productLabelCategoryListQuery,
  response: pagedProductLabelCategories,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [productLabelCategoryExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const catalogAdminLabelCategoryCreate = defineRoute({
  id: 'catalog.adminLabelCategoryCreate',
  method: 'POST',
  path: '/admin-api/catalog/label-categories',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '新建标签分类',
  tags: ['catalog'],
  body: productLabelCategoryForm,
  response: productLabelCategory,
  status: 201,
  errors: ['CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      body: { name: '促销' },
      response: { ...productLabelCategoryExample, labelCount: 0 },
    },
  ],
});

export const catalogAdminLabelCategoryUpdate = defineRoute({
  id: 'catalog.adminLabelCategoryUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/label-categories/:id',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '编辑标签分类',
  tags: ['catalog'],
  params: rowParams,
  body: productLabelCategoryForm,
  response: productLabelCategory,
  errors: ['CATALOG_LABEL_CATEGORY_NOT_FOUND', 'CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'rename',
      params: { id: '1' },
      body: { name: '活动' },
      response: { ...productLabelCategoryExample, name: '活动' },
    },
  ],
});

export const catalogAdminLabelCategoryDelete = defineRoute({
  id: 'catalog.adminLabelCategoryDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/label-categories/:id',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '删除标签分类',
  tags: ['catalog'],
  params: rowParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_LABEL_CATEGORY_NOT_FOUND'],
  // Labels in the category are *not* deleted; they lose their grouping
  // (`product_labels.category_id` is `ON DELETE SET NULL`).
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export const catalogAdminLabelList = defineRoute({
  id: 'catalog.adminLabelList',
  method: 'GET',
  path: '/admin-api/catalog/labels',
  auth: 'admin',
  permission: 'catalog:label:read',
  summary: '商品标签列表',
  tags: ['catalog'],
  query: productLabelListQuery,
  response: pagedProductLabels,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [productLabelExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'enabled-only',
      query: { page: 1, pageSize: 20, isEnabled: 'true' },
      response: { items: [productLabelExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const catalogAdminLabelCreate = defineRoute({
  id: 'catalog.adminLabelCreate',
  method: 'POST',
  path: '/admin-api/catalog/labels',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '新建商品标签',
  tags: ['catalog'],
  body: productLabelForm,
  response: productLabel,
  status: 201,
  errors: ['CATALOG_LABEL_CATEGORY_NOT_FOUND', 'CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'text-label',
      body: {
        categoryId: '1',
        name: '包邮',
        style: 'text',
        fontColor: '#FFFFFF',
        backgroundColor: '#E93323',
      },
      response: { ...productLabelExample, productCount: 0 },
    },
  ],
});

export const catalogAdminLabelUpdate = defineRoute({
  id: 'catalog.adminLabelUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/labels/:id',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '编辑商品标签',
  tags: ['catalog'],
  params: rowParams,
  body: productLabelForm,
  response: productLabel,
  errors: ['CATALOG_LABEL_NOT_FOUND', 'CATALOG_LABEL_CATEGORY_NOT_FOUND', 'CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'recolour',
      params: { id: '3' },
      body: {
        categoryId: '1',
        name: '包邮',
        style: 'text',
        fontColor: '#FFFFFF',
        backgroundColor: '#FF6A00',
      },
      response: { ...productLabelExample, backgroundColor: '#FF6A00' },
    },
  ],
});

export const catalogAdminLabelSetEnabled = defineRoute({
  id: 'catalog.adminLabelSetEnabled',
  method: 'POST',
  path: '/admin-api/catalog/labels/:id/enabled',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '启用/停用商品标签',
  tags: ['catalog'],
  params: rowParams,
  body: productLabelEnabledBody,
  response: productLabel,
  errors: ['CATALOG_LABEL_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '3' },
      body: { isEnabled: false },
      response: { ...productLabelExample, isEnabled: false },
    },
  ],
});

export const catalogAdminLabelDelete = defineRoute({
  id: 'catalog.adminLabelDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/labels/:id',
  auth: 'admin',
  permission: 'catalog:label:write',
  summary: '删除商品标签',
  tags: ['catalog'],
  params: rowParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_LABEL_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '3' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// parameter templates
// ---------------------------------------------------------------------------

export const catalogAdminParamTemplateList = defineRoute({
  id: 'catalog.adminParamTemplateList',
  method: 'GET',
  path: '/admin-api/catalog/param-templates',
  auth: 'admin',
  permission: 'catalog:param:read',
  summary: '商品参数列表',
  tags: ['catalog'],
  query: productParamTemplateListQuery,
  response: pagedProductParamTemplates,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [productParamTemplateExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const catalogAdminParamTemplateCreate = defineRoute({
  id: 'catalog.adminParamTemplateCreate',
  method: 'POST',
  path: '/admin-api/catalog/param-templates',
  auth: 'admin',
  permission: 'catalog:param:write',
  summary: '新建商品参数',
  tags: ['catalog'],
  body: productParamTemplateForm,
  response: productParamTemplate,
  status: 201,
  errors: ['CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      body: { name: '面料', suggestedValues: '纯棉\n涤纶\n亚麻' },
      response: productParamTemplateExample,
    },
  ],
});

export const catalogAdminParamTemplateUpdate = defineRoute({
  id: 'catalog.adminParamTemplateUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/param-templates/:id',
  auth: 'admin',
  permission: 'catalog:param:write',
  summary: '编辑商品参数',
  tags: ['catalog'],
  params: rowParams,
  body: productParamTemplateForm,
  response: productParamTemplate,
  errors: ['CATALOG_PARAM_TEMPLATE_NOT_FOUND', 'CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'add-value',
      params: { id: '1' },
      body: { name: '面料', suggestedValues: '纯棉\n涤纶\n亚麻\n真丝' },
      response: { ...productParamTemplateExample, suggestedValues: '纯棉\n涤纶\n亚麻\n真丝' },
    },
  ],
});

export const catalogAdminParamTemplateSetEnabled = defineRoute({
  id: 'catalog.adminParamTemplateSetEnabled',
  method: 'POST',
  path: '/admin-api/catalog/param-templates/:id/enabled',
  auth: 'admin',
  permission: 'catalog:param:write',
  summary: '启用/停用商品参数',
  tags: ['catalog'],
  params: rowParams,
  body: productParamTemplateEnabledBody,
  response: productParamTemplate,
  errors: ['CATALOG_PARAM_TEMPLATE_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '1' },
      body: { isEnabled: false },
      response: { ...productParamTemplateExample, isEnabled: false },
    },
  ],
});

export const catalogAdminParamTemplateDelete = defineRoute({
  id: 'catalog.adminParamTemplateDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/param-templates/:id',
  auth: 'admin',
  permission: 'catalog:param:write',
  summary: '删除商品参数',
  tags: ['catalog'],
  params: rowParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_PARAM_TEMPLATE_NOT_FOUND'],
  // Parameters already copied onto a product stay: `product_params.template_id`
  // is `ON DELETE SET NULL`, so a retired template never blanks a product page.
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// protections
// ---------------------------------------------------------------------------

export const catalogAdminProtectionList = defineRoute({
  id: 'catalog.adminProtectionList',
  method: 'GET',
  path: '/admin-api/catalog/protections',
  auth: 'admin',
  permission: 'catalog:protection:read',
  summary: '商品保障服务列表',
  tags: ['catalog'],
  query: productProtectionListQuery,
  response: pagedProductProtections,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [productProtectionExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const catalogAdminProtectionCreate = defineRoute({
  id: 'catalog.adminProtectionCreate',
  method: 'POST',
  path: '/admin-api/catalog/protections',
  auth: 'admin',
  permission: 'catalog:protection:write',
  summary: '新建商品保障服务',
  tags: ['catalog'],
  body: productProtectionForm,
  response: productProtection,
  status: 201,
  errors: ['CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      body: {
        title: '七天无理由退换',
        content: '自签收之日起 7 天内，商品保持完好可申请退换。',
      },
      response: productProtectionExample,
    },
  ],
});

export const catalogAdminProtectionUpdate = defineRoute({
  id: 'catalog.adminProtectionUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/protections/:id',
  auth: 'admin',
  permission: 'catalog:protection:write',
  summary: '编辑商品保障服务',
  tags: ['catalog'],
  params: rowParams,
  body: productProtectionForm,
  response: productProtection,
  errors: ['CATALOG_PROTECTION_NOT_FOUND', 'CATALOG_NAME_TAKEN'],
  examples: [
    {
      name: 'reword',
      params: { id: '1' },
      body: { title: '七天无理由退换', content: '签收后 7 天内支持无理由退换。' },
      response: { ...productProtectionExample, content: '签收后 7 天内支持无理由退换。' },
    },
  ],
});

export const catalogAdminProtectionSetEnabled = defineRoute({
  id: 'catalog.adminProtectionSetEnabled',
  method: 'POST',
  path: '/admin-api/catalog/protections/:id/enabled',
  auth: 'admin',
  permission: 'catalog:protection:write',
  summary: '启用/停用商品保障服务',
  tags: ['catalog'],
  params: rowParams,
  body: productProtectionEnabledBody,
  response: productProtection,
  errors: ['CATALOG_PROTECTION_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '1' },
      body: { isEnabled: false },
      response: { ...productProtectionExample, isEnabled: false },
    },
  ],
});

export const catalogAdminProtectionDelete = defineRoute({
  id: 'catalog.adminProtectionDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/protections/:id',
  auth: 'admin',
  permission: 'catalog:protection:write',
  summary: '删除商品保障服务',
  tags: ['catalog'],
  params: rowParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_PROTECTION_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});
