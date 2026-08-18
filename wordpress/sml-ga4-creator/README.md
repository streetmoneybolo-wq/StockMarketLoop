# SML GA4 Creator Attribution 1.0.0

Step 1 of the creator analytics dashboard: get GA4 onto public pages, and tag
every creator-owned page with `creator_handle` so the data is queryable per
creator later.

**The dashboard is step 4.** This has to run and collect for a few weeks first.

---

## Why this comes first

Verified on production, logged out. The public homepage is 54,835 bytes of HTML
with **exactly one script tag** and:

```
googletagmanager   0
google-analytics   0
gtag / dataLayer   0
GA4 id / GTM id    none
```

The `GTM-P7JG7KC4` container fires only for signed-in Creator Studio users —
backwards for creator analytics, since the audience creators care about is
logged out. **There is currently nothing to build a dashboard on.**

---

## The decision that cannot be undone

**GA4 cannot backfill a custom dimension.** Traffic collected before
`creator_handle` exists is permanently unattributable — you would have months of
pageviews you cannot split per creator, with no way to repair it.

So: create the dimensions **before** setting the Measurement ID.

Segmenting by `pagePath` was the alternative and was rejected. It breaks the
moment a URL changes and needs a different filter per content type. A custom
dimension is stable across letters, videos, profiles and live rooms — including
content types that do not exist yet.

---

## Setup, in this order

**1. In GA4 → Admin → Data display → Custom definitions**, create two
**event-scoped** custom dimensions:

| Dimension name | Event parameter |
|---|---|
| Creator Handle | `creator_handle` |
| Content Kind | `content_kind` |

**2. Install and activate this plugin.** It is inert until step 3 — no
Measurement ID means nothing is emitted.

**3. Settings → GA4 Creator**, paste your `G-XXXXXXXXXX`.

**4. Verify** in GA4 Realtime. Load `/n/{some-handle}/` logged out, then check
Realtime → view by `Creator Handle`. If the dimension shows `(not set)`, the
dimension was created after collection began — see the warning above.

**5. Wait 2–4 weeks**, then build the dashboard.

---

## Delivery — why it hooks twice

Several SML screens are echoed as complete HTML documents and never call
`wp_head()` or `wp_footer()`. This is not theoretical: a WPCode snippet on
`site_wide_header` **and** on `site_wide_footer` both failed to print on the
signed-in homepage, which is rendered by *StockMarketLoop Optimized Home*.

**A tag that misses your busiest pages is worse than no tag**, because the
numbers look real and are wrong. So this uses both paths:

- `wp_head` at priority 1 where it runs
- an output-buffer injector at `template_redirect` priority `-2000000` where it
  does not, matching the technique `sml-settings` 1.3.1 documents

The injector is deliberately paranoid: complete HTML documents only, GET only,
never inside REST/AJAX/cron, skips anything already carrying the marker or any
other `gtag/js` include, and returns the page untouched on any `Throwable`.
Nothing here is worth a blank page.

---

## Cache safety

Batcache is active (`x-nananana: Batcache-Set`). Everything emitted is a
property of the **content**, not the viewer — `creator_handle` and
`content_kind` are identical for every visitor to that URL, so a cached page
carries correct values and no identity can leak between visitors.

**Do not add viewer-specific values to the config payload.** That is precisely
the mistake full-page caching punishes, and it is how one member's identifiers
end up in another member's analytics.

---

## What gets detected

| URL | `creator_handle` | `content_kind` |
|---|---|---|
| `/n/{handle}/` | handle | `publication` |
| `/n/{handle}/{letter}/` | handle | `letter` |
| Any singular post/page | author's nicename | `post` |
| Author archive / profile | that user's nicename | `profile` |

**Watch pages, live rooms and group pages are not detected.** I only implemented
patterns I could verify. Guessing a URL scheme and silently attributing traffic
to the wrong creator is worse than returning nothing — wrong numbers still look
like numbers.

Extend with the filter, not by editing the file:

```php
add_filter( 'sml_ga4_creator_context', function ( $ctx, $path ) {
    if ( preg_match( '#^watch/(\d+)#', $path, $m ) ) {
        $author = get_post_field( 'post_author', (int) $m[1] );
        if ( $author ) {
            $u = get_userdata( (int) $author );
            if ( $u ) {
                $ctx['handle'] = $u->user_nicename;
                $ctx['kind']   = 'video';
            }
        }
    }
    return $ctx;
}, 10, 2 );
```

---

## Consent

Consent Mode v2 is included, **denied by default in the EEA, UK and Switzerland
only**. Region-scoped rather than global on purpose: a blanket denial zeroes out
analytics for your whole audience, and a blanket grant is not lawful for
European visitors. Google resolves the region itself, so no geo lookup is needed.

When you add a consent banner, call:

```js
gtag('consent', 'update', { analytics_storage: 'granted' });
```

Until then, European visitors are counted only in Google's modelled, cookieless
form. **This plugin does not make you compliant** — it makes compliance
possible. The banner and your privacy policy are still yours to write.

---

## Two deliberate choices you may want to flip

**Administrators are excluded.** An admin browsing the site all day would
otherwise show up as a creator's most engaged audience.

**Creators viewing their own page are NOT excluded.** Tempting, but a creator
who opens their own page to check it and sees the counter stay at zero concludes
the feature is broken — that support cost outweighs the small inflation. Flip it
once creators trust the numbers:

```php
add_filter( 'sml_ga4_creator_should_measure', function ( $measure ) {
    // exclude a creator viewing their own content
    return $measure;
} );
```

---

## When you build the dashboard (step 4)

- **Map:** `runReport`, dimensions `country` + `city`, filtered on
  `creator_handle`. Cache per creator ~15 minutes in a transient. Never call GA
  on page load — that is how the daily quota disappears.
- **Live:** `runRealtimeReport`, same filter. Last 30 minutes only, tighter
  quota, cache ~60 seconds.
- **Auth:** a Google Cloud service account with the GA4 Data API enabled, added
  as Viewer on the property. The key stays server-side — never in the browser.
- **Thresholding:** GA4 hides small numbers. Creators with modest traffic will
  legitimately see gaps, so the empty state must say *"not enough data yet"*,
  not *"0"*.
- **Privacy:** aggregate counts by country/city with a minimum threshold. Never
  individual rows — a live feed of "someone in Galway at 14:32" is
  re-identifiable when a creator's audience is small.
