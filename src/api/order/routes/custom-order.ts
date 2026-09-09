export default {
  routes: [
    {
      method: 'GET',
      path: '/orders/my',
      handler: 'order.myOrders',
      config: {
        auth: {},
      },
    },
    {
      method: 'POST',
      path: '/payments/create-intent',
      handler: 'order.createPaymentIntent',
      config: {
        auth: {},
      },
    },
    {
      method: 'POST',
      path: '/payments/finalize',
      handler: 'order.finalizePayment',
      config: {
        auth: {},
      },
    },
  ],
}
