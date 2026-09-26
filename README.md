<p align="center"><img src="assets/wins-logo.png" alt="WIns" height="120"></p>

# WIns Delivery

**Live demo: https://winsksa.github.io/wins-delivery/**

A delivery app in the style of Amazon and noon, in **Arabic and English**. The customer's location decides which delivery zone they are in and which store serves them. The app then shows only that store's products and stock.

## Features

**Customer side**
- Detects the customer's location automatically (browser GPS). If location is blocked, the customer taps the map or picks a neighborhood.
- Finds the delivery zone and picks the right store automatically. Shows delivery time, delivery fee and minimum order.
- "Why this store?" shows the ranked list of stores and why each one was or wasn't chosen.
- Catalog filtered to the chosen store's stock, with categories and search in both languages.
- Cart, minimum-order check, checkout (cash or card on delivery), and order tracking.

**Admin side**
- **Zones:** draw delivery zones on the map and set fee, minimum order, color, and Arabic and English names.
- **Stores:** set location and opening hours (overnight hours supported), preparation time, and which zones the store covers as **primary** or **backup**.
- **Products:** manage the catalog, prices, and stock per store.
- **Orders:** move each order from placed to delivered.
- **Location tester:** click anywhere on the map to see which zone and store a customer there gets.

**Languages:** full Arabic (right-to-left) and English, switched with one button. Currency is Saudi riyal (SAR / ر.س).

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

The app ships with sample data for Riyadh: 8 zones, 7 stores and 24 products. **Admin → Overview → Reset demo data** restores it.

## Project structure

| File | What it holds |
| --- | --- |
| `index.html` | Page shell: header, views, location picker |
| `app.js` | Store selection logic, shop, cart, checkout, orders, admin |
| `i18n.js` | All interface text in English and Arabic |
| `styles.css` | Design tokens (WIns gold), layout, right-to-left rules, dark mode |
| `assets/` | Logo, logo mark and app icon |

## Customizing

- **Currency:** change `currency` in `i18n.js` (`SAR` and `ر.س`).
- **Text and translations:** edit `i18n.js`.
- **Brand colors:** edit the tokens at the top of `styles.css`.
- **Map starting point:** edit `MAP_CENTER` in `app.js`.

## Current limitations

This is a working front-end prototype. Data is saved in the browser's local storage, so each device has its own copy. A production launch needs:

- a backend API and database for zones, stores, products, inventory and orders
- a login for the admin section
- online payments (mada, Apple Pay, cards)
- a driver app and live order tracking
- notifications (SMS or push)
- native Android and iOS apps
