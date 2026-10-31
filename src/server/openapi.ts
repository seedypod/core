import { generateOpenApiDocument } from 'trpc-to-openapi'
import { appRouter } from './routers/app'

export function openApiDocument(baseUrl: string) {
  return generateOpenApiDocument(appRouter, {
    title: 'seedypod core API',
    description: 'Local, cloud-free control of a Gardyn hydroponic tower. LAN-only; no authentication.',
    version: '1.0.0',
    baseUrl,
    docsUrl: 'https://seedypod.github.io/developers/api',
  })
}
