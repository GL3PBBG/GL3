import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'GL3',
  description: 'GL3 developer documentation',
  // GitHub Pages serves project sites under /<repo>/.
  base: '/',
  lastUpdated: true,
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'Tutorials', link: '/tutorials/getting-started' },
      { text: 'Guides', link: '/guides/create-a-plugin' },
      { text: 'Reference', link: '/reference/repo-layout' },
      { text: 'Decisions', link: '/explanation/' },
      { text: 'Operators', link: '/operators/' },
    ],
    sidebar: [
      {
        text: 'Tutorials',
        items: [
          { text: 'Getting started', link: '/tutorials/getting-started' },
        ],
      },
      {
        text: 'How-to guides',
        items: [
          { text: 'Create a plugin', link: '/guides/create-a-plugin' },
          { text: 'Add a migration', link: '/guides/add-a-migration' },
          { text: 'Testing conventions', link: '/guides/testing-conventions' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Repository layout', link: '/reference/repo-layout' },
          { text: 'Error codes', link: '/reference/errors' },
        ],
      },
      {
        text: 'Design decisions',
        items: [
          { text: 'Overview', link: '/explanation/' },
          { text: 'ADR template', link: '/explanation/adr/template' },
          {
            text: 'ADR 0001 - reports expire, not consume',
            link: '/explanation/adr/0001-detective-reports-expire-not-consume',
          },
        ],
      },
      {
        text: 'Operators',
        items: [{ text: 'Operator guide', link: '/operators/' }],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/rondlite/GL3' }],
    editLink: {
      pattern: 'https://github.com/rondlite/GL3/edit/main/manual/:path',
      text: 'Edit this page',
    },
  },
})
