# blog

Terminal-themed personal blog built with [Astro](https://astro.build) and deployed to GitHub Pages.

## Configure (one time)

1. In `astro.config.mjs`, set `site` to `https://ishtiaque05.github.io` and `base` to `/blog`
   (use your real GitHub username and repo name).
2. Push this repo to GitHub under that name.
3. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Push to `main` — the workflow builds and deploys automatically.

## Local development

Requires Node 24 (`.nvmrc`).

```bash
npm install
npm run dev      # local preview at http://localhost:4321/blog/
npm run build    # production build into dist/
```

## Writing a post

Create a Markdown file in `src/content/blog/`, e.g. `my-post.md`:

```markdown
---
title: "My post title"
description: "One-line summary shown in lists and meta."
date: 2026-06-16
tags: ["web", "notes"]
draft: false
---

Your content here. Use fenced code blocks for syntax highlighting and
![alt](/blog/images/file.png) for images (files go in `public/images/`;
keep the `/blog` base prefix in the path).
```

The filename becomes the URL slug. `draft: true` hides a post from the build.

## Customizing the look

All colors, fonts, and spacing are CSS variables at the top of
`src/styles/theme.css`. Edit that token block to restyle the whole site.
