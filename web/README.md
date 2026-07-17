# Privos Cluster — Admin UI

Vite + React 18 + TypeScript + Tailwind + shadcn-style components.

## Dev

```bash
cd web
npm install
npm run dev          # http://localhost:5173, proxies /api → http://localhost:4000
```

Before the login form will accept anything, set `ADMIN_PASSWORD` in the cluster
backend's `.env` and restart the backend:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-now
```

## Build

```bash
npm run build        # outputs dist/
npm run preview      # serves dist/ on http://localhost:4173
```

## Adding shadcn components

`components.json` is already configured. To add more components later:

```bash
npx shadcn@latest add dialog table tabs ...
```

## Structure

```
src/
├── main.tsx                 # React entry
├── App.tsx                  # Router + providers
├── index.css                # Tailwind + shadcn CSS vars
├── lib/
│   ├── api.ts               # axios client with JWT interceptor
│   ├── auth-context.tsx     # login/logout/me state
│   └── utils.ts             # cn() class merger
├── components/
│   ├── ui/                  # shadcn primitives (button, input, ...)
│   ├── layout/              # app shell, sidebar, topbar
│   ├── theme-provider.tsx
│   └── protected-route.tsx
└── routes/
    ├── login.tsx
    ├── dashboard.tsx
    ├── containers.tsx       # placeholder for Day 3
    ├── images.tsx           # placeholder for Day 4
    └── settings.tsx
```
