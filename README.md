# 🩺 Sanjeevni AI — Deployment Guide

A 3D AI doctor avatar powered by:
- **React + Three.js** (3D Avatar Frontend)
- **Node.js + Express** (Backend: TTS, Lip Sync, AI)
- **Groq LLaMA** (AI brain)
- **Murf AI** (Text-to-Speech)
- **Rhubarb Lip Sync** (Mouth animation)

---

## 🏗️ Project Structure

```
Sanjeevni-AI-1/
├── Backend/    → Node.js Express server (port 3125)
└── Frontend/   → React + Vite + Three.js app
```

---

## 🚀 Step-by-Step Deployment

### Step 1 — Deploy Backend to Railway

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Select your repo → choose the **`Backend`** folder as the root
3. Railway auto-detects the `nixpacks.toml` and installs `ffmpeg` ✅
4. Add these **Environment Variables** in Railway dashboard:

| Variable | Value |
|----------|-------|
| `GROQ_API_KEY` | your Groq API key |
| `MURF_API_KEY` | your Murf API key |
| `MURF_VOICE_ID` | `Natalie` |
| `MURF_LOCALE` | `en-US` |
| `PORT` | (Railway sets this automatically) |
| `CORS_ORIGIN` | `https://your-app.vercel.app` ← fill after Step 2 |

> ⚠️ **Rhubarb Lip Sync**: nixpacks installs ffmpeg but NOT Rhubarb (no Linux Nix package).
> If you need Rhubarb on the server, use the **`Dockerfile`** instead of nixpacks.toml.
> In Railway: Settings → Builder → switch from Nixpacks to **Dockerfile**.

5. After deploy, copy your Railway URL → e.g. `https://sanjeevni-backend.up.railway.app`

---

### Step 2 — Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project → Import Git Repository**
2. Select your repo → set **Root Directory** to `Frontend`
3. Framework preset: **Vite** ✅
4. Add this **Environment Variable** in Vercel:

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | `https://sanjeevni-backend.up.railway.app` ← your Railway URL |

5. Click Deploy → copy your Vercel URL
6. Go back to Railway → update `CORS_ORIGIN` to your Vercel URL

---

## 💻 Local Development

### Backend
```bash
cd Backend
npm install
# copy .env.example → .env and fill in your keys + local Windows paths
npm run dev
```

### Frontend
```bash
cd Frontend
npm install
# create Frontend/.env with: VITE_API_URL=http://localhost:3125
npm run dev
```

---

## 🔑 API Keys Needed

| Service | Get it at |
|---------|-----------|
| Groq | https://console.groq.com |
| Murf AI | https://murf.ai |

---

## ⚙️ Environment Variables Reference

### Backend (`.env`)
See `Backend/.env.example` for full template.

### Frontend
See `Frontend/.env.example` for full template.
