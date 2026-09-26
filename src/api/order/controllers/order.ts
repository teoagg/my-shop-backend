import { Buffer } from 'node:buffer'
import { factories } from '@strapi/strapi'

type CartItemPayload = {
  id?: unknown
  documentId?: unknown
  quantity?: unknown
}

type ProductEntity = {
  id: number
  documentId?: string
  title?: string
  price?: number | string
  inStock?: boolean
  stockCount?: number
  slug?: string
}

type OrderLineItem = {
  id: number
  slug?: string
  title?: string
  quantity: number
  price: number
}

class OrderPayloadError extends Error {}

function normalizeCartItems(items: unknown) {
  if (!Array.isArray(items) || items.length === 0) {
    return null
  }

  const quantities = new Map<string, number>()

  for (const item of items as CartItemPayload[]) {
    const documentId =
      typeof item.documentId === 'string' && item.documentId.length > 0
        ? item.documentId
        : null
    const numericId = Number(item.id)
    const quantity = Number(item.quantity)

    if (!documentId && (!Number.isInteger(numericId) || numericId <= 0)) return null
    if (!Number.isInteger(quantity) || quantity <= 0) return null

    const key = documentId || String(numericId)
    quantities.set(key, (quantities.get(key) || 0) + quantity)
  }

  return quantities
}

function getProductKey(product: ProductEntity, requestedKeys: Set<string>) {
  if (product.documentId && requestedKeys.has(product.documentId)) {
    return product.documentId
  }

  return String(product.id)
}

function getOrderStatus(value: unknown) {
  return value === 'paid' ? 'paid' : 'pending'
}

function getStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY

  if (!key || !key.startsWith('sk_test_')) {
    return null
  }

  return key
}

async function stripeRequest(path: string, params?: URLSearchParams): Promise<any> {
  const secretKey = getStripeSecretKey()

  if (!secretKey) {
    throw new OrderPayloadError('Stripe test secret key is not configured in Strapi.')
  }

  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params,
  })

  const data = (await response.json().catch(() => null)) as any

  if (!response.ok) {
    throw new OrderPayloadError(data?.error?.message || 'Stripe request failed.')
  }

  return data
}

async function buildOrderFromCart(strapi: any, payloadItems: unknown) {
  const quantities = normalizeCartItems(payloadItems)

  if (!quantities) {
    throw new OrderPayloadError('Invalid order payload.')
  }

  const productRefs = Array.from(quantities.keys())
  const requestedKeys = new Set(productRefs)
  const numericIds = productRefs
    .map((ref) => Number(ref))
    .filter((ref) => Number.isInteger(ref) && ref > 0)
  const documentIds = productRefs.filter((ref) => !Number.isInteger(Number(ref)))

  const products = (await strapi.entityService.findMany('api::product.product', {
    filters: {
      $or: [
        {
          id: {
            $in: numericIds,
          },
        },
        {
          documentId: {
            $in: documentIds,
          },
        },
      ],
    },
    fields: ['id', 'documentId', 'title', 'price', 'inStock', 'stockCount', 'slug'],
  })) as ProductEntity[]

  if (products.length !== productRefs.length) {
    throw new OrderPayloadError('One or more products were not found.')
  }

  const items: OrderLineItem[] = []

  for (const product of products) {
    const key = getProductKey(product, requestedKeys)
    const quantity = quantities.get(key) || 0
    const price = Number(product.price)
    const stockCount = Number(product.stockCount || 0)

    if (!product.inStock || stockCount < quantity) {
      throw new OrderPayloadError(`Product ${product.id} is out of stock.`)
    }

    items.push({
      id: product.id,
      slug: product.slug,
      title: product.title,
      quantity,
      price,
    })
  }

  const total = Number(
    items
      .reduce((sum, item) => sum + item.price * item.quantity, 0)
      .toFixed(2)
  )

  return { items, total }
}

async function createOrder(strapi: any, userId: number, items: OrderLineItem[], total: number, status: 'pending' | 'paid', paymentIntentId?: string) {
  return strapi.entityService.create('api::order.order', {
    data: {
      items,
      total,
      user: userId,
      status,
      ...(paymentIntentId ? { paymentIntentId } : {}),
    },
    populate: ['user'],
  })
}

export default factories.createCoreController('api::order.order', ({ strapi }) => ({
  async create(ctx) {
    const user = ctx.state.user

    if (!user) {
      return ctx.unauthorized('You must be logged in.')
    }

    try {
      const { items, total } = await buildOrderFromCart(strapi, ctx.request.body.data?.items)
      const order = await createOrder(
        strapi,
        user.id,
        items,
        total,
        getOrderStatus(ctx.request.body.data?.status)
      )

      return this.transformResponse(order)
    } catch (error) {
      if (error instanceof OrderPayloadError) {
        return ctx.badRequest(error.message)
      }

      throw error
    }
  },

  async createPaymentIntent(ctx) {
    const user = ctx.state.user

    if (!user) {
      return ctx.unauthorized('You must be logged in.')
    }

    try {
      const { items, total } = await buildOrderFromCart(strapi, ctx.request.body.data?.items)
      const params = new URLSearchParams()

      params.append('amount', String(Math.round(total * 100)))
      params.append('currency', 'eur')
      params.append('automatic_payment_methods[enabled]', 'true')
      params.append('metadata[user_id]', String(user.id))
      params.append('metadata[source]', 'strapi_embedded_checkout')
      params.append('metadata[item_count]', String(items.length))

      const paymentIntent = await stripeRequest('payment_intents', params)

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        total,
      }
    } catch (error) {
      if (error instanceof OrderPayloadError) {
        return ctx.badRequest(error.message)
      }

      throw error
    }
  },

  async finalizePayment(ctx) {
    const user = ctx.state.user
    const paymentIntentId = ctx.request.body.data?.paymentIntentId

    if (!user) {
      return ctx.unauthorized('You must be logged in.')
    }

    if (typeof paymentIntentId !== 'string' || !paymentIntentId.startsWith('pi_')) {
      return ctx.badRequest('Invalid payment intent.')
    }

    try {
      const paymentIntent = await stripeRequest(
        `payment_intents/${encodeURIComponent(paymentIntentId)}`
      )

      if (paymentIntent.status !== 'succeeded') {
        return ctx.badRequest('Payment has not succeeded.')
      }

      const paymentUserId = paymentIntent.metadata?.user_id

      if (paymentUserId && paymentUserId !== String(user.id)) {
        return ctx.badRequest('Payment belongs to a different user.')
      }

      const { items, total } = await buildOrderFromCart(strapi, ctx.request.body.data?.items)
      const expectedAmount = Math.round(total * 100)

      if (paymentIntent.amount !== expectedAmount || paymentIntent.currency !== 'eur') {
        return ctx.badRequest('Payment amount does not match the cart.')
      }

      const order = await createOrder(strapi, user.id, items, total, 'paid', paymentIntent.id)

      return this.transformResponse(order)
    } catch (error) {
      if (error instanceof OrderPayloadError) {
        return ctx.badRequest(error.message)
      }

      throw error
    }
  },

  async myOrders(ctx) {
    const user = ctx.state.user

    if (!user) {
      return ctx.unauthorized('You must be logged in.')
    }

    const orders = await strapi.entityService.findMany('api::order.order', {
      filters: {
        user: {
          id: {
            $eq: user.id,
          },
        },
      },
      sort: { createdAt: 'desc' },
      populate: ['user'],
    })

    return this.transformResponse(orders)
  },
}))
