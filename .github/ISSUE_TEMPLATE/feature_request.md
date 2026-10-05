---
name: Feature request
about: Suggest a diagnostic, an integration, or an improvement
title: '[feat] '
labels: enhancement
assignees: ''
---

## The problem

What are you trying to diagnose or do, and what makes it hard today? Describe the problem, not just
the solution.

## Proposed solution

What would you like Argus to do?

## Fit with Argus

Argus is in-process, dependency-free in the agent, and local-first. Please say how your idea fits:

- Which module would own it? <!-- agent | collector | analyzer | dashboard | plugin-runner | new adapter -->
- Would it need a third-party dependency? <!-- the agent cannot take one; adapters can be opt-in -->
- Could it add overhead on the monitored process's hot path?

## Alternatives considered

Other approaches, or how you work around it today.

## Additional context

Links, screenshots, or example output from other tools.
