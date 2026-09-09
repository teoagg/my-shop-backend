const WEIGHTS: Record<string, number> = {
  purchase: 5,
  add_to_cart: 3,
  recommendation_click: 2,
  view: 1,
  recommendation_impression: 0.25,
}

function parseLimit(value: unknown) {
  const limit = Number(value)
  if (!Number.isInteger(limit)) return 4
  return Math.min(Math.max(limit, 1), 8)
}

function productFilters(productId: unknown, documentId: unknown) {
  const filters = []
  const numericId = Number(productId)

  if (Number.isInteger(numericId) && numericId > 0) {
    filters.push({ id: numericId })
  }

  if (typeof documentId === 'string' && documentId.trim()) {
    filters.push({ documentId: documentId.trim() })
  }

  return filters
}

async function findTargetProduct(strapi: any, query: any) {
  const filters = productFilters(query.productId || query.id, query.documentId)

  if (filters.length === 0) return null

  if (typeof query.documentId === 'string' && query.documentId.trim()) {
    return strapi.documents('api::product.product').findOne({
      documentId: query.documentId.trim(),
      status: 'published',
      fields: ['id', 'documentId', 'title', 'slug', 'price', 'inStock', 'stockCount'],
      populate: ['categories', 'image'],
    })
  }

  const products = await strapi.entityService.findMany('api::product.product', {
    filters: filters.length === 1 ? filters[0] : { $or: filters },
    fields: ['id', 'documentId', 'title', 'slug', 'price', 'inStock', 'stockCount'],
    populate: ['categories', 'image'],
    limit: 10,
  })

  return products?.find((item: any) => item.publishedAt) || products?.[0] || null
}

async function fetchProducts(strapi: any, ids: number[], limit: number) {
  if (ids.length === 0) return []

  const products = await strapi.documents('api::product.product').findMany({
    status: 'published',
    filters: {
      id: { $in: ids },
      inStock: true,
    },
    populate: ['categories', 'image'],
    limit,
  })

  const byId = new Map(products.map((product: any) => [product.id, product]))
  return ids.map((id) => byId.get(id)).filter(Boolean)
}

async function collaborativeCandidates(strapi: any, product: any, limit: number) {
  const relatedSessions = await strapi.entityService.findMany(
    'api::interaction.interaction',
    {
      filters: {
        product: { id: product.id },
        eventType: { $in: ['view', 'add_to_cart', 'purchase', 'recommendation_click'] },
      },
      fields: ['sessionId'],
      limit: 1000,
    }
  )

  const sessions = Array.from(
    new Set(relatedSessions.map((interaction: any) => interaction.sessionId).filter(Boolean))
  )

  if (sessions.length === 0) return []

  const interactions = await strapi.entityService.findMany(
    'api::interaction.interaction',
    {
      filters: {
        sessionId: { $in: sessions },
        product: { id: { $ne: product.id } },
      },
      fields: ['eventType'],
      populate: ['product'],
      limit: 3000,
    }
  )

  const scores = new Map<number, number>()

  for (const interaction of interactions as any[]) {
    const id = interaction.product?.id
    if (!id) continue
    scores.set(id, (scores.get(id) || 0) + (WEIGHTS[interaction.eventType] || 0))
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
}

async function categoryFallback(strapi: any, product: any, limit: number) {
  const categoryIds = (product.categories || []).map((category: any) => category.id)

  if (categoryIds.length === 0) return []

  const products = await strapi.documents('api::product.product').findMany({
    status: 'published',
    filters: {
      id: { $ne: product.id },
      inStock: true,
      categories: { id: { $in: categoryIds } },
    },
    populate: ['categories', 'image'],
    sort: { createdAt: 'desc' },
    limit: 50,
  })

  return products.slice(0, limit)
}

async function popularFallback(strapi: any, product: any, limit: number, exclude: number[]) {
  const interactions = await strapi.entityService.findMany(
    'api::interaction.interaction',
    {
      filters: {
        product: { id: { $notIn: [product.id, ...exclude] } },
      },
      fields: ['eventType'],
      populate: ['product'],
      limit: 3000,
    }
  )

  const scores = new Map<number, number>()

  for (const interaction of interactions as any[]) {
    const id = interaction.product?.id
    if (!id) continue
    scores.set(id, (scores.get(id) || 0) + (WEIGHTS[interaction.eventType] || 0))
  }

  const ids = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)

  return fetchProducts(strapi, ids, limit)
}

async function latestFallback(strapi: any, product: any, limit: number, exclude: number[]) {
  const products = await strapi.documents('api::product.product').findMany({
    status: 'published',
    filters: {
      id: { $notIn: [product.id, ...exclude] },
      inStock: true,
    },
    populate: ['categories', 'image'],
    sort: { createdAt: 'desc' },
    limit: 50,
  })

  return products.slice(0, limit)
}

export default {
  async find(ctx: any) {
    const limit = parseLimit(ctx.query.limit)
    const product = await findTargetProduct(strapi, ctx.query)

    if (!product) {
      return ctx.badRequest('Product was not found.')
    }

    const collaborativeIds = await collaborativeCandidates(strapi, product, limit)
    const collaborativeProducts = await fetchProducts(strapi, collaborativeIds, limit)
    const categoryProducts = await categoryFallback(
      strapi,
      product,
      limit - collaborativeProducts.length
    )
    const categoryIds = categoryProducts.map((item: any) => item.id)
    const popularProducts = await popularFallback(
      strapi,
      product,
      limit - collaborativeProducts.length - categoryProducts.length,
      [...collaborativeIds, ...categoryIds]
    )
    const usedIds = [
      ...collaborativeProducts.map((item: any) => item.id),
      ...categoryProducts.map((item: any) => item.id),
      ...popularProducts.map((item: any) => item.id),
    ]
    const latestProducts = await latestFallback(
      strapi,
      product,
      limit - usedIds.length,
      usedIds
    )

    const seen = new Set<number>()
    const data = [
      ...collaborativeProducts.map((item: any) => ({ ...item, recommendationReason: 'collaborative' })),
      ...categoryProducts.map((item: any) => ({ ...item, recommendationReason: 'category' })),
      ...popularProducts.map((item: any) => ({ ...item, recommendationReason: 'popular' })),
      ...latestProducts.map((item: any) => ({ ...item, recommendationReason: 'latest' })),
    ].filter((item: any) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    }).slice(0, limit)

    ctx.body = {
      data,
      meta: {
        algorithm: 'item-session collaborative filtering with category/popularity fallback',
      },
    }
  },
}
