export default {
  routes: [
    {
      method: 'POST',
      path: '/interactions/track',
      handler: 'interaction.track',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/interactions/summary',
      handler: 'interaction.summary',
      config: {
        auth: false,
      },
    },
  ],
}
