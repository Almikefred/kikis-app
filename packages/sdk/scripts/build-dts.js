import { execSync } from 'node:child_process'

const entries = [
  ['index', 'src/index.ts'],
  ['client', 'src/client/index.ts'],
  ['provider', 'src/provider/index.ts'],
  ['react', 'src/react/index.ts'],
  ['testing', 'src/testing/index.ts'],
  ['provider/hono', 'src/provider/hono.ts'],
  ['provider/fastify', 'src/provider/fastify.ts'],
  ['schema', 'src/schema.ts'],
]

for (const [name, path] of entries) {
  execSync(`npx tsup --entry.${name} ${path} --dts-only`, { stdio: 'inherit' })
}
