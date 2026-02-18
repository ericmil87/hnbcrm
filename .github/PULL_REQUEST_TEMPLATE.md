## What changed and why

<!-- Describe the motivation and context for this PR. Link any related issues. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation update
- [ ] Refactor / code cleanup

## Checklist

- [ ] `npm run lint` passes (`tsc` + `convex dev --once` + `vite build`)
- [ ] Tested locally against a Convex dev deployment
- [ ] New Convex functions have `args` and `returns` validators
- [ ] No `.filter()` on queries — uses `.withIndex()` instead
- [ ] Multi-tenant: all new queries are scoped to `organizationId`
- [ ] User-facing strings are in PT-BR

## Screenshots / recordings

<!-- If this changes any UI, add before/after screenshots or a short screen recording. -->
