import { generateOpenApiDocument } from 'trpc-to-openapi'
import { appRouter } from './routers/app'

export function openApiDocument(baseUrl: string) {
  return generateOpenApiDocument(appRouter, {
    title: 'leafypod core API',
    description: 'Local, cloud-free control of a Gardyn hydroponic tower. LAN-only; no authentication.',
    version: '1.0.0',
    baseUrl,
    docsUrl: 'https://leafypod.github.io/developers/api',
  })
}
