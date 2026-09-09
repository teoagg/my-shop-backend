const Database = require('better-sqlite3')

const db = new Database('.tmp/data.db')

const now = () => Date.now()
const documentId = () =>
  Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)

const description = (text) =>
  JSON.stringify([
    {
      type: 'paragraph',
      children: [{ type: 'text', text }],
    },
  ])

const categories = [
  {
    name: 'Accessories',
    slug: 'accessories',
    description: 'Chargers, headphones and useful accessories for everyday use.',
  },
  {
    name: 'Wearables',
    slug: 'wearables',
    description: 'Smart wearable devices for notifications, health and activity tracking.',
  },
]

const products = [
  {
    title: 'iPad Air 11',
    slug: 'ipad-air-11',
    price: 749,
    stock: 7,
    category: 'Laptops',
    imageId: 4,
    description:
      'Lightweight tablet for productivity, notes and entertainment with fast response.',
  },
  {
    title: 'Dell XPS 13',
    slug: 'dell-xps-13',
    price: 1299,
    stock: 4,
    category: 'Laptops',
    imageId: 2,
    description:
      'Premium ultrabook for students and professionals who need portability.',
  },
  {
    title: 'Samsung Galaxy S26',
    slug: 'samsung-galaxy-s26',
    price: 1049,
    stock: 8,
    category: 'Smartphones',
    imageId: 4,
    description:
      'High performance Android smartphone focused on camera quality and battery life.',
  },
  {
    title: 'Sony WH-1000XM6',
    slug: 'sony-wh-1000xm6',
    price: 399,
    stock: 10,
    category: 'Accessories',
    imageId: 3,
    description:
      'Wireless noise cancelling headphones for focused work, study and travel.',
  },
  {
    title: 'Apple Watch Series 11',
    slug: 'apple-watch-series-11',
    price: 479,
    stock: 6,
    category: 'Wearables',
    imageId: 4,
    description:
      'Smartwatch with notifications, activity tracking and useful health features.',
  },
  {
    title: 'USB-C GaN Charger 100W',
    slug: 'usb-c-gan-charger-100w',
    price: 79,
    stock: 20,
    category: 'Accessories',
    imageId: 3,
    description:
      'Fast multi-port charger for laptops, tablets and smartphones.',
  },
  {
    title: 'Lenovo ThinkPad X1 Carbon',
    slug: 'lenovo-thinkpad-x1-carbon',
    price: 1699,
    stock: 3,
    category: 'Laptops',
    imageId: 2,
    description:
      'Business laptop with durable construction and strong daily performance.',
  },
  {
    title: 'Google Pixel 10',
    slug: 'google-pixel-10',
    price: 899,
    stock: 9,
    category: 'Smartphones',
    imageId: 4,
    description:
      'Clean Android smartphone with fast updates and AI camera features.',
  },
]

const getCategoryPair = db.prepare(`
  select
    max(case when published_at is null then id end) as draft_id,
    max(case when published_at is not null then id end) as published_id,
    max(document_id) as document_id,
    max(name) as name,
    max(slug) as slug,
    max(description) as description
  from categories
  where slug = ?
`)

const insertCategory = db.prepare(`
  insert into categories
    (document_id, name, slug, description, created_at, updated_at, published_at, created_by_id, updated_by_id, locale)
  values
    (@document_id, @name, @slug, @description, @created_at, @updated_at, @published_at, 1, 1, null)
`)

const getProductRows = db.prepare(`
  select *
  from products
  where slug = ?
  order by published_at is null desc, id asc
`)

const insertProduct = db.prepare(`
  insert into products
    (document_id, title, slug, description, price, in_stock, stock_count, created_at, updated_at, published_at, created_by_id, updated_by_id, locale)
  values
    (@document_id, @title, @slug, @description, @price, 1, @stock_count, @created_at, @updated_at, @published_at, 1, 1, null)
`)

const getImageLink = db.prepare(`
  select file_id
  from files_related_mph
  where related_id = ?
    and related_type = 'api::product.product'
    and field = 'image'
  order by id desc
  limit 1
`)

const hasImageLink = db.prepare(`
  select id
  from files_related_mph
  where file_id = ?
    and related_id = ?
    and related_type = 'api::product.product'
    and field = 'image'
  limit 1
`)

const insertImageLink = db.prepare(`
  insert into files_related_mph (file_id, related_id, related_type, field, "order")
  values (?, ?, 'api::product.product', 'image', 1)
`)

const hasCategoryLink = db.prepare(`
  select id
  from products_categories_lnk
  where product_id = ?
    and category_id = ?
  limit 1
`)

const insertCategoryLink = db.prepare(`
  insert into products_categories_lnk (product_id, category_id, category_ord, product_ord)
  values (?, ?, 1, 1)
`)

const ensureImageLink = (productId, imageId) => {
  if (!imageId || hasImageLink.get(imageId, productId)) return
  insertImageLink.run(imageId, productId)
}

const ensureCategoryLink = (productId, categoryId) => {
  if (!categoryId || hasCategoryLink.get(productId, categoryId)) return
  insertCategoryLink.run(productId, categoryId)
}

const ensureCategoryPair = (category) => {
  const timestamp = now()
  let pair = getCategoryPair.get(category.slug)
  const docId = pair && pair.document_id ? pair.document_id : documentId()

  if (!pair || (!pair.draft_id && !pair.published_id)) {
    const draft = insertCategory.run({
      document_id: docId,
      name: category.name,
      slug: category.slug,
      description: category.description,
      created_at: timestamp,
      updated_at: timestamp,
      published_at: null,
    })
    const published = insertCategory.run({
      document_id: docId,
      name: category.name,
      slug: category.slug,
      description: category.description,
      created_at: timestamp,
      updated_at: timestamp,
      published_at: timestamp,
    })
    return { draftId: draft.lastInsertRowid, publishedId: published.lastInsertRowid }
  }

  if (!pair.draft_id) {
    const draft = insertCategory.run({
      document_id: docId,
      name: pair.name || category.name,
      slug: pair.slug || category.slug,
      description: pair.description || category.description,
      created_at: timestamp,
      updated_at: timestamp,
      published_at: null,
    })
    pair = { ...pair, draft_id: draft.lastInsertRowid }
  }

  if (!pair.published_id) {
    const published = insertCategory.run({
      document_id: docId,
      name: pair.name || category.name,
      slug: pair.slug || category.slug,
      description: pair.description || category.description,
      created_at: timestamp,
      updated_at: timestamp,
      published_at: timestamp,
    })
    pair = { ...pair, published_id: published.lastInsertRowid }
  }

  return { draftId: pair.draft_id, publishedId: pair.published_id }
}

const ensureProductPair = (product, categoryIds) => {
  const timestamp = now()
  const rows = getProductRows.all(product.slug)
  const draft = rows.find((row) => row.published_at === null)
  const published = rows.find((row) => row.published_at !== null)
  const docId = (draft || published)?.document_id || documentId()
  const body = description(product.description)

  let draftId = draft?.id
  let publishedId = published?.id
  let created = 0

  if (!draftId) {
    const source = published || product
    const result = insertProduct.run({
      document_id: docId,
      title: source.title || product.title,
      slug: source.slug || product.slug,
      description: source.description || body,
      price: source.price || product.price,
      stock_count: source.stock_count || product.stock,
      created_at: source.created_at || timestamp,
      updated_at: timestamp,
      published_at: null,
    })
    draftId = result.lastInsertRowid
    created += 1
  }

  if (!publishedId) {
    const source = draft || product
    const result = insertProduct.run({
      document_id: docId,
      title: source.title || product.title,
      slug: source.slug || product.slug,
      description: source.description || body,
      price: source.price || product.price,
      stock_count: source.stock_count || product.stock,
      created_at: source.created_at || timestamp,
      updated_at: timestamp,
      published_at: timestamp,
    })
    publishedId = result.lastInsertRowid
    created += 1
  }

  const existingImageId =
    getImageLink.get(draftId)?.file_id || getImageLink.get(publishedId)?.file_id || product.imageId

  ensureImageLink(draftId, existingImageId)
  ensureImageLink(publishedId, existingImageId)
  ensureCategoryLink(draftId, categoryIds.get(product.category)?.draftId)
  ensureCategoryLink(publishedId, categoryIds.get(product.category)?.publishedId)

  return created
}

const seed = db.transaction(() => {
  const categoryIds = new Map()

  for (const row of db.prepare('select name, slug from categories').all()) {
    categoryIds.set(row.name, ensureCategoryPair({ ...row, description: '' }))
  }

  for (const category of categories) {
    categoryIds.set(category.name, ensureCategoryPair(category))
  }

  let touchedRows = 0

  for (const product of products) {
    touchedRows += ensureProductPair(product, categoryIds)
  }

  return touchedRows
})

const touchedRows = seed()
console.log(
  `Demo seed complete. Added ${touchedRows} missing draft/published rows and repaired media/category links.`
)
