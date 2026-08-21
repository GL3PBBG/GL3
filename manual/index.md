---
layout: home

hero:
  name: GL3
  text: Developer documentation
  tagline: Contributor guides, plugin reference, and design decisions for the GL3 game server.
  actions:
    - theme: brand
      text: Get started
      link: /tutorials/getting-started
    - theme: alt
      text: Write a plugin
      link: /guides/create-a-plugin

features:
  - title: Tutorials
    details: Learning-oriented walkthroughs. Get GL3 running locally and build your first plugin.
    link: /tutorials/getting-started
  - title: How-to guides
    details: Task-oriented recipes for people who already know the system - migrations, routes, plugin dependencies.
    link: /guides/create-a-plugin
  - title: Reference
    details: The API surface - routes, DTOs, settings namespaces, and error codes.
    link: /reference/errors
  - title: Design decisions
    details: Why things are the way they are. Dated, immutable ADRs and design docs.
    link: /explanation/
---

## How GL3 compares to V2

[**Two Gangster Engines**](/gl3-vs-v2.html) - a comparison of this engine against
[Gangster Legends V2](https://github.com/ChristopherDay/Gangster-Legends-V2), the PHP 5.6-era
script it reimplements. Measured by reading both source trees rather than either project's
documentation: what each is better at, what reached parity, and the three places GL3
deliberately diverges.

It is a standalone page rather than a Diátaxis section on purpose - it is neither tutorial,
guide, reference nor ADR, and folding it into one of the four would break the rule below.

## About this documentation

This documentation follows the [Diátaxis](https://diataxis.fr/) framework: each page is
exactly one of a **tutorial** (learning), a **how-to guide** (task), **reference**
(information), or an **explanation** (understanding). When you add a page, decide which
of the four it is first - mixed pages serve nobody.

Documentation lives in the repo under `manual/` and is updated in the same PR as the
code it describes. If your change alters a route, a DTO, an error code, or a convention,
the doc change belongs in the diff.
