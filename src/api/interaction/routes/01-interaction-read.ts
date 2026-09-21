import { factories } from '@strapi/strapi'

// Install in src/api/interaction/routes/. Keep Public and Authenticated find disabled.
// Grant interaction.find only to a dedicated custom API token.
export default factories.createCoreRouter('api::interaction.interaction', {
  only: ['find'],
})
