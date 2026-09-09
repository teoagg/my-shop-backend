import { factories } from '@strapi/strapi'

const EVENT_TYPES = new Set([
  'view',
  'add_to_cart',
  'purchase',
  'recommendation_impression',
  'recommendation_click',
])

const VARIANTS = new Set(['A', 'B'])

type InteractionInput = {
  eventType?: unknown
  productId?: unknown
  documentId?: unknown
  sessionId?: unknown
  variant?: unknown
  source?: unknown
  metadata?: unknown
}

function normalizeInput(body: any): InteractionInput {
  return body?.data || body || {}
}

function getProductFilters(productId: unknown, documentId: unknown) {
  const numericId = Number(productId)
  const filters = []

  if (Number.isInteger(numericId) && numericId > 0) {
    filters.push({ id: numericId })
  }

  if (typeof documentId === 'string' && documentId.trim()) {
    filters.push({ documentId: documentId.trim() })
  }

  return filters
}

async function findProduct(strapi: any, productId: unknown, documentId: unknown) {
  const filters = getProductFilters(productId, documentId)

  if (filters.length === 0) return null

  if (typeof documentId === 'string' && documentId.trim()) {
    return strapi.documents('api::product.product').findOne({
      documentId: documentId.trim(),
      status: 'published',
      fields: ['id', 'documentId', 'title', 'slug'],
    })
  }

  const products = await strapi.entityService.findMany('api::product.product', {
    filters: filters.length === 1 ? filters[0] : { $or: filters },
    fields: ['id', 'documentId', 'title', 'slug'],
    limit: 10,
  })

  return products?.find((product: any) => product.publishedAt) || products?.[0] || null
}

function rateLimitKey(ctx: any) {
  return `${ctx.request.ip}:${ctx.request.path}`
}

const recentWrites = new Map<string, number>()

function isRateLimited(ctx: any) {
  const key = rateLimitKey(ctx)
  const current = Date.now()
  const last = recentWrites.get(key) || 0

  recentWrites.set(key, current)
  return current - last < 250
}

export default factories.createCoreController(
  'api::interaction.interaction',
  ({ strapi }) => ({
    async track(ctx) {
      if (isRateLimited(ctx)) {
        return ctx.tooManyRequests('Too many analytics events.')
      }

      const input = normalizeInput(ctx.request.body)
      const eventType = typeof input.eventType === 'string' ? input.eventType : ''
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
      const variant = typeof input.variant === 'string' && VARIANTS.has(input.variant)
        ? input.variant
        : 'A'

      if (!EVENT_TYPES.has(eventType)) {
        return ctx.badRequest('Invalid interaction event type.')
      }

      if (sessionId.length < 8 || sessionId.length > 120) {
        return ctx.badRequest('Invalid session id.')
      }

      const product = await findProduct(strapi, input.productId, input.documentId)

      if (!product) {
        return ctx.badRequest('Product was not found.')
      }

      const data: any = {
        eventType,
        sessionId,
        variant,
        source: typeof input.source === 'string' ? input.source.slice(0, 80) : null,
        product: product.id,
        user: ctx.state.user?.id || null,
        metadata:
          input.metadata && typeof input.metadata === 'object'
            ? input.metadata
            : null,
      }

      const interaction = await strapi.entityService.create(
        'api::interaction.interaction',
        {
          data,
        }
      )

      return this.transformResponse(interaction)
    },

    async summary(ctx) {
      const interactions = await strapi.entityService.findMany(
        'api::interaction.interaction',
        {
          fields: ['eventType', 'variant', 'sessionId'],
          limit: 5000,
          sort: { createdAt: 'desc' },
        }
      )

      const summary = {
        A: {
          sessions: new Set<string>(),
          views: 0,
          addToCart: 0,
          purchases: 0,
          recommendationClicks: 0,
          recommendationImpressions: 0,
        },
        B: {
          sessions: new Set<string>(),
          views: 0,
          addToCart: 0,
          purchases: 0,
          recommendationClicks: 0,
          recommendationImpressions: 0,
        },
      }

      for (const interaction of interactions as any[]) {
        const variant = interaction.variant === 'B' ? 'B' : 'A'
        summary[variant].sessions.add(interaction.sessionId)

        if (interaction.eventType === 'view') summary[variant].views += 1
        if (interaction.eventType === 'add_to_cart') summary[variant].addToCart += 1
        if (interaction.eventType === 'purchase') summary[variant].purchases += 1
        if (interaction.eventType === 'recommendation_click') {
          summary[variant].recommendationClicks += 1
        }
        if (interaction.eventType === 'recommendation_impression') {
          summary[variant].recommendationImpressions += 1
        }
      }

      const data = Object.entries(summary).map(([variant, item]) => {
        const sessions = item.sessions.size
        const ctr =
          item.recommendationImpressions > 0
            ? item.recommendationClicks / item.recommendationImpressions
            : 0

        return {
          variant,
          sessions,
          views: item.views,
          addToCart: item.addToCart,
          purchases: item.purchases,
          recommendationImpressions: item.recommendationImpressions,
          recommendationClicks: item.recommendationClicks,
          addToCartRate: sessions > 0 ? item.addToCart / sessions : 0,
          conversionRate: sessions > 0 ? item.purchases / sessions : 0,
          recommendationCtr: ctr,
        }
      })

      ctx.body = { data }
    },
  })
)
