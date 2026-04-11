# Covenant — Design & Branding Spec

## The Vibe
Dark gothic Art Nouveau meets supernatural intimacy. Think: a Victorian occult sanctum where your AI companion lives. Not cheesy Halloween — sophisticated, ornate, moody. Like candlelit cathedral meets enchanted library.

**Keywords:** Gothic, Art Nouveau, Victorian, witchy, demonic elegance, ornate, intimate, mystical

**NOT this:** Flat/corporate, cheesy skulls, generic dark mode, minimalist, sterile

---

## Brand Identity

| Property | Value |
|----------|-------|
| **App Name** | Covenant |
| **Companion** | Zephyr (customizable) |
| **Tagline** | *"Always. Forever. And in every update."* |
| **Mood** | Dark romantic, intimate, a little dangerous |
| **Personality** | The UI should feel alive — like it's watching you, like it was MADE for you |

---

## Color Palette

### Primary Colors
| Name | Hex | Use |
|------|-----|-----|
| **Void** | `#0a0710` | Deepest background, page base |
| **Obsidian** | `#120e1a` | Card/panel backgrounds |
| **Nightshade** | `#1a1428` | Elevated surfaces, input fields |
| **Amethyst** | `#2a1f3d` | User message bubbles, hover states |

### Accent Colors
| Name | Hex | Use |
|------|-----|-----|
| **Violet** | `#9b72cf` | Primary accent, buttons, links, active states |
| **Lavender** | `#b088e3` | Hover states, secondary accent |
| **Pale Orchid** | `#d4b8f0` | Highlights, selection, emphasis text |
| **Ghost** | `#e8e0f0` | Primary text (soft lavender-white, not pure white) |

### Metallic Accents (for ornamental details)
| Name | Hex | Use |
|------|-----|-----|
| **Antique Gold** | `#c9a84c` | Ornate borders, filigree, decorative flourishes |
| **Tarnished Silver** | `#8a8697` | Secondary metallic, subtle details |
| **Rose Gold** | `#b76e79` | Warm accent (reactions, hearts, special moments) |

### Semantic Colors
| Name | Hex | Use |
|------|-----|-----|
| **Blood** | `#8b2942` | Errors, destructive actions, warnings |
| **Poison** | `#2d6b4f` | Success states |
| **Ember** | `#a85d2a` | Caution, pending states |

---

## Typography

### Fonts
| Role | Font | Fallback | Weight |
|------|------|----------|--------|
| **Display/Headers** | Cinzel Decorative | Cinzel, Georgia, serif | 400-700 |
| **Subheaders** | Cinzel | Georgia, serif | 400-600 |
| **Body** | Inter | system-ui, sans-serif | 300-500 |
| **Monospace** | JetBrains Mono | Fira Code, monospace | 400 |
| **Accent/Labels** | Cormorant Garamond | Georgia, serif | 400-600 (italic for flavor) |

### Scale
| Element | Size | Font | Weight |
|---------|------|------|--------|
| Page title | 1.75rem | Cinzel Decorative | 700 |
| Section header | 1.25rem | Cinzel | 600 |
| Card header | 1rem | Cinzel | 500 |
| Body text | 0.9375rem | Inter | 400 |
| Small/caption | 0.8125rem | Inter | 300 |
| Timestamp | 0.75rem | Cormorant Garamond | 400 italic |
| Code | 0.875rem | JetBrains Mono | 400 |

---

## Layout Structure

### Screens to Design

```
+------------------------------------------+
|  MAIN LAYOUT                             |
|  +--------+  +------------------------+ |
|  | SIDEBAR |  |      CHAT AREA         | |
|  |         |  |                        | |
|  | Thread  |  |  Messages scroll here  | |
|  | List    |  |                        | |
|  |         |  |  [companion bubble]    | |
|  |         |  |       [user bubble]    | |
|  |         |  |  [companion bubble]    | |
|  |         |  |                        | |
|  |         |  +------------------------+ |
|  |         |  |    MESSAGE INPUT       | |
|  +--------+  +------------------------+ |
+------------------------------------------+
```

### Screen List
1. **Setup Wizard** (3 steps — Meet, Soul, Done)
2. **Login** (password entry)
3. **Chat** (main view — sidebar + messages + input)
4. **Settings** (preferences, personality editor, MCP manager)
5. **Command Center** (dashboard + sub-pages)
6. **Files** (uploaded files gallery)

---

## Figma Asset Checklist

These are the custom assets that make the difference between "purple CSS" and "gothic masterpiece":

### Window Frames & Borders
- [ ] **Chat panel frame** — ornate border around the main chat area (Art Nouveau vine/arch motif)
- [ ] **Sidebar frame** — matching frame for the thread list
- [ ] **Card frame** — reusable ornate border for cards/panels (settings sections, CC cards)
- [ ] **Modal frame** — for dialogs and confirmation popups
- [ ] **Input frame** — decorative border around the message input area

### Backgrounds & Textures
- [ ] **Page background** — dark subtle texture (aged parchment-dark, subtle noise, or faint damask pattern)
- [ ] **Message area background** — slightly different from page (maybe subtle cathedral window light effect)
- [ ] **Sidebar background** — could have faint bookshelf/library texture
- [ ] **Header bar texture** — ornate strip across the top

### Buttons
- [ ] **Primary button** — ornate, maybe with small flourishes on corners (Send, Save, Launch)
- [ ] **Secondary button** — more subtle version (Back, Cancel)
- [ ] **Destructive button** — dark red/blood variant (Delete, Archive)
- [ ] **Icon buttons** — small circular ornate frames for toolbar icons (settings gear, CC icon, etc.)

### Message Bubbles
- [ ] **Companion message frame** — left-aligned, ornate left border or frame (maybe a thin vine/arch motif)
- [ ] **User message frame** — right-aligned, simpler but matching
- [ ] **System message style** — centered, subtle, maybe italic with decorative dividers

### Decorative Elements
- [ ] **Divider/separator** — ornate horizontal line with flourish (replaces plain `<hr>`)
- [ ] **Section flourish** — small decorative element above section headers
- [ ] **Corner ornaments** — for cards and panels (top-left, bottom-right)
- [ ] **Loading spinner** — custom (maybe a rotating sigil/pentagram instead of a generic spinner?)
- [ ] **Empty state illustration** — for "no messages yet" (maybe an open spellbook or empty chalice)

### Icons (optional but impactful)
- [ ] **Custom nav icons** — Settings (gear with flourish), CC (ornate compass), Files (scroll), Chat (quill)
- [ ] **Reaction set** — custom gothic emoji/icons instead of standard Unicode emoji
- [ ] **Status indicators** — online/offline/thinking as custom glyphs (candle lit/unlit?)

### Character/Companion
- [ ] **Companion avatar** — for message bubbles (Zephyr's face/icon)
- [ ] **Header companion art** — optional hero image for the sidebar or header
- [ ] **Stickers/decorations** — fun overlays (like that girl's duck with sunglasses)

---

## Component Specifications

### Message Bubble (Companion)
```
+-- ornate left border or frame --+
|  [Avatar] Zephyr         12:34  |
|                                  |
|  Message text goes here with     |
|  full markdown support and       |
|  proper wrapping.                |
|                                  |
|  [reactions row]                 |
+----------------------------------+
```
- Background: `Obsidian` (#12101a)
- Border: ornate left accent or full frame (Figma asset)
- Avatar: 32px circle with companion image
- Name: `Cinzel`, `Violet` color
- Timestamp: `Cormorant Garamond italic`, `Tarnished Silver`
- Text: `Inter 400`, `Ghost`

### Message Bubble (User)
```
         +-- simpler right frame --+
         |           You    12:35  |
         |                         |
         |  User message text here |
         |                         |
         +-------------------------+
```
- Background: `Amethyst` (#2a1f3d)
- Simpler frame than companion
- Right-aligned

### Message Input
```
+-- ornate input frame ---------------------------------+
|  [attach] | Type your message...        | [send btn] |
|           | / for commands               |            |
+-------------------------------------------------------+
```
- Frame: decorative border (Figma asset)
- Textarea: transparent bg, placeholder in `Tarnished Silver`
- Send button: ornate primary button

### Thread List Item
```
+-- subtle ornate border --+
|  Thread Name       3:42p |
|  Last message previ...   |
+---------------------------+
```
- Active state: `Amethyst` bg with `Violet` left accent
- Hover: `Nightshade` bg
- Pinned indicator: small `Antique Gold` pin icon

### Setup Wizard Step
```
+---- ornate page frame ----+
|     ( 1 ) ( 2 ) ( 3 )    |
|                            |
|   ✦ Meet Your Companion   |
|   Describe who they are   |
|                            |
|   [ ornate input fields ] |
|                            |
|       [ Next Button ]     |
+----------------------------+
```
- Full ornate frame around the card
- Step indicators: small sigils or numbered circles
- Title: `Cinzel Decorative`

---

## Animations & Effects

| Element | Effect |
|---------|--------|
| Page transitions | Subtle fade (200ms) |
| Toast notifications | Slide in from right |
| Modal open | Scale from 0.95 to 1.0 + fade |
| Hover on ornate elements | Subtle glow (box-shadow with violet) |
| Loading | Custom spinner (rotating sigil?) |
| Message appear | Fade in + slight upward slide |
| Button hover | Subtle glow + slight brightness increase |
| Focus ring | Violet glow (not browser default blue) |

---

## How To Use This Doc

### For Figma:
1. Set up the color palette as color styles
2. Create frames at these sizes: Desktop (1440x900), Tablet (768x1024), Mobile (375x812)
3. Design each screen using the layout structure above
4. Export decorative elements as SVGs (frames, borders, flourishes, dividers)
5. Export backgrounds as PNGs (textures, patterns)
6. Export buttons/icons as SVGs

### For Implementation (Azael handles this):
1. SVG frames → CSS `border-image` or positioned `::before`/`::after` pseudo-elements
2. Texture backgrounds → CSS `background-image` with overlay
3. Custom fonts → Google Fonts or self-hosted @font-face
4. Custom spinner → SVG animation or CSS keyframes
5. Button assets → either CSS recreation or `background-image` on button elements

### Asset Export Settings:
- **SVGs:** for anything vector (frames, icons, flourishes) — scales to any size
- **PNGs @2x:** for textures and raster backgrounds — export at 2x for retina
- **Keep file sizes small:** optimize with SVGO for SVGs, TinyPNG for PNGs

---

## Reference Mood Board

**Architecture:** Art Nouveau doorways, iron vine railings, cathedral rose windows
**Texture:** Dark aged leather, candlelit stone walls, velvet curtains
**Typography:** Victorian book title pages, apothecary labels, tarot card text
**Color feel:** Deep night sky with purple aurora, amethyst geodes, dark orchids
**UI inspiration:** That unhinged Windows 97 girl but make it DARK and ELEGANT
**NOT:** Generic dark mode, gaming/neon, corporate SaaS, flat design

---

*This document is the north star. Every design decision should feel like it belongs in the same candlelit room.*
