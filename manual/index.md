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
    details: The API surface - DTOs, events, WS frames, error codes, and the repo layout.
    link: /reference/errors
  - title: Design decisions
    details: Why things are the way they are. Dated, immutable ADRs and design docs.
    link: /explanation/
---

## How GL3 compares to V2

<a href="/gl3-vs-v2.html" target="_self"><strong>Two Gangster Engines</strong></a> - a comparison of this engine against
[Gangster Legends V2](https://github.com/ChristopherDay/Gangster-Legends-V2), the PHP 5.6-era
script it reimplements. Measured by reading both source trees rather than either project's
documentation: what each is better at, what reached parity, and the three places GL3
deliberately diverges.

It is a standalone page rather than a Diátaxis section on purpose - it is neither tutorial,
guide, reference nor ADR, and folding it into one of the four would break the rule below.

## System architecture

<a href="/architecture.html" target="_self"><strong>GL3 system architecture</strong></a> - an explorable map of
the running system: the React client, the one Fastify process that hosts the API, the WS
gateway, the plugin loader and the BullMQ workers, and the PostgreSQL, Redis and asset
storage behind it, plus the `gl3-migrate` path in from a legacy MySQL database. Four guided
views walk the request path, the plugin surface, the outbox-driven job and event flow, and
the legacy import.

Like the comparison above it is a standalone page rather than a Diátaxis section.

## About this documentation

This documentation follows the [Diátaxis](https://diataxis.fr/) framework: each page is
exactly one of a **tutorial** (learning), a **how-to guide** (task), **reference**
(information), or an **explanation** (understanding). When you add a page, decide which
of the four it is first - mixed pages serve nobody.

Documentation lives in the repo under `manual/` and is updated in the same PR as the
code it describes. If your change alters a route, a DTO, an error code, or a convention,
the doc change belongs in the diff.
