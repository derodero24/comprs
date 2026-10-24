// @ts-check
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

// The site imports @derodero24/comprs as users do: the file:.. dependency
// installs the package from the repository root with the files it would be
// published with, and Vite resolves its browser entry through the package
// exports. Run `pnpm run build:js` and `pnpm run build:wasm-bindgen` in the
// repository root before `pnpm install` here.
//
// COMPRS_PLAYGROUND_MOCK=1 substitutes fake compressors for the package in
// the playground, for UI work without the WebAssembly build.
const useMock = process.env.COMPRS_PLAYGROUND_MOCK === '1';

export default defineConfig({
  site: 'https://derodero24.github.io',
  base: '/comprs',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'comprs',
      description:
        'zstd, brotli, gzip and LZ4 compression for Node.js, Deno, Bun and browsers, with one API. Native speed on the server, WebAssembly in the browser.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/derodero24/comprs' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@derodero24/comprs' },
      ],
      editLink: { baseUrl: 'https://github.com/derodero24/comprs/edit/develop/website/' },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      plugins: [
        // Fails the build on a broken link between pages, or to a heading
        // that does not exist.
        // The playground is a page of its own, outside the docs, which the
        // validator cannot see.
        starlightLinksValidator({ errorOnLocalLinks: false, exclude: ['/comprs/playground/'] }),
        starlightTypeDoc({
          entryPoints: ['../index.d.ts', '../streams.d.ts', '../node.d.ts', '../next/index.d.ts'],
          tsconfig: './tsconfig.typedoc.json',
          output: 'api',
          sidebar: { label: 'API reference', collapsed: true },
          typeDoc: {
            readme: './typedoc-readme.md',
            excludePrivate: true,
            excludeInternal: true,
          },
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            'getting-started',
            'choosing-an-algorithm',
            { label: 'Playground', link: '/playground/' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Migration', items: [{ autogenerate: { directory: 'migration' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        typeDocSidebarGroup,
      ],
    }),
  ],
  vite: {
    resolve: {
      alias: useMock
        ? {
            '@derodero24/comprs': fileURLToPath(
              new URL('./src/playground/comprs-mock.js', import.meta.url),
            ),
          }
        : {},
    },
    server: {
      // The benchmark charts come from .github/assets in the repository.
      fs: { allow: ['..'] },
    },
    worker: {
      // The playground's worker imports the browser entry, which uses
      // top-level await.
      format: 'es',
    },
  },
});
