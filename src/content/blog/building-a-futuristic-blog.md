---
title: "Building a futuristic blog"
description: "How this terminal-themed Astro blog is put together, with code and an image."
date: 2026-06-10
tags: ["web", "astro"]
---

This post demonstrates the three content features: headings, images, and
syntax-highlighted code.

## A code block

```js
export function greet(name) {
  return `hello, ${name}`;
}
console.log(greet('world'));
```

## An image

Drop files into `public/images/` and reference them with the full path,
including the `/blog` base (Markdown has no templating, so the base is written out):

![A placeholder diagram](/blog/images/example.png)

> Tip: public-folder images need the base-prefixed absolute path
> (`/blog/images/...`) because a post lives at a nested URL like `/blog/posts/<slug>/`.
