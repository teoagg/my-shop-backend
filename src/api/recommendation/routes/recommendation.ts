export default {
  routes: [
    {
      method: 'GET',
      path: '/recommendations',
      handler: 'recommendation.find',
      config: {
        auth: false,
      },
    },
  ],
}
