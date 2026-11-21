<p align="center"><img src="assets/wins-logo.png" alt="WIns" height="120"></p>

# WIns Delivery

**Live demo: https://winsksa.github.io/wins-delivery/**

A lounge delivery app for Riyadh in **Arabic and English**: fruit cheesecakes, Arabic shisha and many kinds of tea, plus **event bookings** (shisha corner, tea station, dessert table). The customer's location decides the delivery zone and the store that serves it, and the menu shows only that store's stock. Data lives in **Supabase**.

## Features

**Customer side**
- Detects the customer's location (GPS), or they tap the map or pick a district.
- Finds the zone and picks the store automatically, with delivery time, fee and minimum order. "Why this store?" shows the ranking.
- Live menu from Supabase: 8 fruit cheesecakes, 9 shisha items, 10 teas.
- Cart, checkout (cash or card on delivery) and order tracking.
- Shisha orders require an **18+ confirmation**, enforced by the database.
- **Events:** 4 packages and a booking request form.

**Admin side** (sign in with an admin account)
- Zones: draw on the map; set fee, minimum order, Arabic and English names.
- Stores: location, opening hours (Saudi time), prep time, primary/backup zone coverage.
- Menu: add items, change prices, list/unlist, stock per store.
- Orders: move from placed to delivered. Event requests: mark contacted, confirmed or cancelled.
- Location tester.

## Backend (Supabase)

- Schema and demo data: [`supabase/migrations`](supabase/migrations). The menu source is [`catalog.json`](catalog.json).
- Row level security on every table. Anyone can read the menu, zones and stores; only admins can read or change orders and event requests, or edit the catalog.
- Customers place orders through `place_order()`, which re-checks the zone, the store's hours, prices, stock, minimum order and the 18+ rule on the server. They track orders with `get_order(code, token)`.
- The app uses only the **publishable** key ([`config.js`](config.js)). Never put the service-role key in this repo.

### Making someone an admin

1. Open the app, go to **Admin**, and choose **Create account**. Confirm the email.
2. In the Supabase SQL editor run:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'owner@example.com';
   ```

## How the store is chosen

1. Find every active zone that contains the customer's location (point-in-polygon). When zones overlap, the smallest zone wins.
2. Collect the stores that cover those zones.
3. Skip stores that are paused or outside opening hours.
4. Prefer **primary** coverage over **backup**, then the nearest store.

The logic is in `resolve()` in [`app.js`](app.js).

## Run it locally

There is no build step. Serve the folder with any static web server:

```bash
python -m http.server 5173
```

Then open http://localhost:5173. Browsers allow location detection on `localhost` and on HTTPS sites.

The demo data covers Riyadh: 8 zones and 7 stores.

## Project structure

| File | What it holds |
| --- | --- |
| `index.html` | Page shell: header, views, location picker |
| `app.js` | Store selection, shop, cart, checkout, events, orders, admin (Supabase) |
| `config.js` | Supabase URL and publishable key |
| `catalog.json` | Menu and event packages (source for the seed) |
| `supabase/migrations/` | Database schema, security rules and demo data |
| `i18n.js` | All interface text in English and Arabic |
| `styles.css` | Design tokens (WIns gold), layout, right-to-left rules, dark mode |
| `assets/` | Logo, logo mark and app icon |

## Customizing

- **Currency:** change `currency` in `i18n.js` (`SAR` and `ر.س`).
- **Text and translations:** edit `i18n.js`.
- **Brand colors:** edit the tokens at the top of `styles.css`.
- **Map starting point:** edit `MAP_CENTER` in `app.js`.

## Current limitations

Data is shared through Supabase. Still to do for a full launch:

- online payments (mada, Apple Pay, cards)
- the free Supabase plan pauses a project after about a week with no activity; upgrade before going live
- a driver app and live order tracking
- notifications (SMS or push)
- native Android and iOS apps
