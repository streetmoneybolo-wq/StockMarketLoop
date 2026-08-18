<?php
/**
 * Plugin Name:       SML GA4 Creator Attribution
 * Plugin URI:        https://stockmarketloop.com
 * Description:       Installs GA4 on public pages and tags every creator-owned page with creator_handle and content_kind, so per-creator analytics are queryable later. Step 1 of the creator analytics dashboard.
 * Version:           1.0.0
 * Author:            StockMarketLoop
 * License:           GPL-2.0-or-later
 * Requires PHP:      7.4
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Verified on production, logged out: the public site has NO analytics at all.
 * The homepage is 54,835 bytes of HTML with exactly one script tag and zero
 * references to googletagmanager, google-analytics, gtag or dataLayer. The
 * GTM-P7JG7KC4 container fires only for signed-in Creator Studio users — which
 * is backwards, since the visitors creators care about are logged out.
 *
 * So there is currently nothing to build a creator dashboard on.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT MUST BE RIGHT ON DAY ONE
 * ---------------------------------------------------------------------------
 * GA4 cannot backfill a custom dimension. If collection starts without
 * `creator_handle`, every pageview gathered before it is added is permanently
 * unattributable — you would have months of traffic you cannot split per
 * creator. That is why this ships before the dashboard, not with it.
 *
 * Segmenting by pagePath was the alternative and was rejected: it breaks the
 * moment a URL changes, and it needs a different filter per content type.
 * A custom dimension is stable across letters, videos, profiles and live rooms,
 * including ones that do not exist yet.
 *
 * ---------------------------------------------------------------------------
 * DELIVERY — WHY NOT JUST wp_head()
 * ---------------------------------------------------------------------------
 * Several SML screens are echoed as complete HTML documents and never call
 * wp_head() or wp_footer(). Confirmed the hard way earlier: a WPCode snippet on
 * site_wide_header AND site_wide_footer both failed to print on the signed-in
 * homepage, which is rendered by StockMarketLoop Optimized Home.
 *
 * A tag that misses the busiest pages is worse than no tag, because the numbers
 * look real and are wrong. So this uses both paths — wp_head where it runs, and
 * an output-buffer injector where it does not, matching the technique
 * sml-settings 1.3.1 documents.
 *
 * ---------------------------------------------------------------------------
 * CACHE SAFETY
 * ---------------------------------------------------------------------------
 * Batcache is active on this site (x-nananana: Batcache-Set). Nothing emitted
 * here is per-visitor: creator_handle and content_kind are properties of the
 * CONTENT, identical for everyone who loads that URL. So a cached page carries
 * correct values and no identity can leak between visitors. Do not add
 * viewer-specific values to the config payload — that is exactly the mistake
 * page caching punishes.
 *
 * @package SML\GA4Creator
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'SML_GA4_Creator_V1', false ) ) {

	final class SML_GA4_Creator_V1 {

		const VERSION     = '1.0.0';
		const OPT_ID      = 'sml_ga4_measurement_id';
		const MARKER      = 'sml-ga4-creator';

		private static $instance = null;

		/** Resolved once per request. */
		private $ctx = null;

		public static function boot() {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}
			return self::$instance;
		}

		private function __construct() {
			add_action( 'wp_head', array( $this, 'print_tag' ), 1 );

			// Fallback for screens that never call wp_head(). Priority must be
			// lower than the groups directory's -900000 or the buffer is not
			// open when it exits.
			add_action( 'template_redirect', array( $this, 'maybe_buffer' ), -2000000 );

			add_action( 'admin_menu', array( $this, 'menu' ) );
			add_action( 'admin_init', array( $this, 'register_setting' ) );
		}

		// ===================================================================
		// Settings
		// ===================================================================

		public function menu() {
			add_options_page(
				'GA4 Creator Attribution',
				'GA4 Creator',
				'manage_options',
				'sml-ga4-creator',
				array( $this, 'settings_page' )
			);
		}

		public function register_setting() {
			register_setting( 'sml_ga4_creator', self::OPT_ID, array(
				'type'              => 'string',
				'sanitize_callback' => array( $this, 'sanitize_id' ),
				'default'           => '',
			) );
		}

		public function sanitize_id( $v ) {
			$v = strtoupper( trim( (string) $v ) );
			return preg_match( '/^G-[A-Z0-9]{6,}$/', $v ) ? $v : '';
		}

		public function settings_page() {
			$id = get_option( self::OPT_ID, '' );
			?>
			<div class="wrap">
				<h1>GA4 Creator Attribution</h1>
				<form method="post" action="options.php">
					<?php settings_fields( 'sml_ga4_creator' ); ?>
					<table class="form-table">
						<tr>
							<th scope="row"><label for="sml-ga4-id">Measurement ID</label></th>
							<td>
								<input name="<?php echo esc_attr( self::OPT_ID ); ?>" id="sml-ga4-id"
									type="text" class="regular-text" placeholder="G-XXXXXXXXXX"
									value="<?php echo esc_attr( $id ); ?>" />
								<p class="description">
									Nothing is emitted until this is set, so the plugin is inert on install.
								</p>
							</td>
						</tr>
					</table>
					<?php submit_button(); ?>
				</form>

				<hr />
				<h2>Before you turn this on</h2>
				<p>
					In <strong>GA4 Admin → Data display → Custom definitions</strong>, create two
					<strong>event-scoped</strong> custom dimensions. Do this <em>first</em> —
					GA4 cannot backfill them, so anything collected beforehand is permanently
					unattributable to a creator.
				</p>
				<table class="widefat striped" style="max-width:720px">
					<thead><tr><th>Dimension name</th><th>Event parameter</th></tr></thead>
					<tbody>
						<tr><td>Creator Handle</td><td><code>creator_handle</code></td></tr>
						<tr><td>Content Kind</td><td><code>content_kind</code></td></tr>
					</tbody>
				</table>

				<h2>What is being tagged right now</h2>
				<?php
				$probe = $this->resolve_context( true );
				echo '<p>On this admin screen the resolver returns: <code>'
					. esc_html( $probe['handle'] ? $probe['handle'] : '(none)' ) . '</code> / <code>'
					. esc_html( $probe['kind'] ? $probe['kind'] : '(none)' ) . '</code> — '
					. 'admin pages are never tagged, so "(none)" here is correct.</p>';
				?>
				<p>
					Extend detection with the <code>sml_ga4_creator_context</code> filter rather than
					editing this file, so a plugin update does not discard your mapping.
				</p>
			</div>
			<?php
		}

		// ===================================================================
		// Who owns this page
		// ===================================================================

		/**
		 * Work out which creator's content is being viewed.
		 *
		 * Only the patterns I could verify are implemented. Everything else is
		 * left to the filter deliberately — guessing a URL scheme and silently
		 * mis-attributing traffic to the wrong creator is worse than returning
		 * nothing, because wrong numbers still look like numbers.
		 *
		 * @return array{handle:string,kind:string}
		 */
		private function resolve_context( $force = false ) {
			if ( null !== $this->ctx && ! $force ) {
				return $this->ctx;
			}

			$handle = '';
			$kind   = '';

			$path = $this->request_path();

			// /n/{handle}[/{letter}] — Loop Letters public pages.
			if ( preg_match( '#^n/([^/]+)(?:/([^/]+))?/?$#', $path, $m ) ) {
				$handle = sanitize_title( $m[1] );
				$kind   = empty( $m[2] ) ? 'publication' : 'letter';
			}

			// Single post/page authored by a member.
			if ( '' === $handle && is_singular() ) {
				$post = get_post();
				if ( $post && $post->post_author ) {
					$u = get_userdata( (int) $post->post_author );
					if ( $u ) {
						$handle = $u->user_nicename;
						$kind   = 'post';
					}
				}
			}

			// Author archive / member profile at /{nicename}/.
			if ( '' === $handle && is_author() ) {
				$u = get_queried_object();
				if ( $u instanceof WP_User ) {
					$handle = $u->user_nicename;
					$kind   = 'profile';
				}
			}

			/**
			 * Map the content types this plugin cannot see: watch pages, live
			 * rooms, group pages, anything served by a WPCode snippet.
			 *
			 * @param array  $ctx  ['handle' => string, 'kind' => string]
			 * @param string $path Request path, no leading or trailing slash.
			 */
			$ctx = apply_filters(
				'sml_ga4_creator_context',
				array( 'handle' => $handle, 'kind' => $kind ),
				$path
			);

			$this->ctx = array(
				'handle' => isset( $ctx['handle'] ) ? sanitize_title( (string) $ctx['handle'] ) : '',
				'kind'   => isset( $ctx['kind'] ) ? sanitize_key( (string) $ctx['kind'] ) : '',
			);

			return $this->ctx;
		}

		private function request_path() {
			$uri  = isset( $_SERVER['REQUEST_URI'] )
				? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) )
				: '';
			$path = (string) wp_parse_url( $uri, PHP_URL_PATH );

			$home = (string) wp_parse_url( home_url(), PHP_URL_PATH );
			if ( $home && '/' !== $home && 0 === strpos( $path, $home ) ) {
				$path = substr( $path, strlen( $home ) );
			}
			return trim( $path, '/' );
		}

		// ===================================================================
		// Should this request be measured
		// ===================================================================

		private function applies() {
			if ( is_admin() || is_feed() || is_preview() ) {
				return false;
			}
			if ( wp_doing_ajax() || wp_doing_cron() ) {
				return false;
			}
			if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
				return false;
			}
			if ( '' === (string) get_option( self::OPT_ID, '' ) ) {
				return false;
			}

			// Administrators are excluded: an admin browsing the site all day
			// would otherwise show up as a creator's most engaged audience.
			//
			// Creators viewing their OWN page are NOT excluded by default. It
			// is tempting, but a creator who opens their page to check it and
			// sees the counter stay at zero concludes the feature is broken,
			// and that support cost outweighs the small inflation. Flip it with
			// the filter below once creators trust the numbers.
			if ( current_user_can( 'manage_options' ) ) {
				return false;
			}

			/**
			 * @param bool $measure Whether to emit the tag for this request.
			 */
			return (bool) apply_filters( 'sml_ga4_creator_should_measure', true );
		}

		// ===================================================================
		// Output
		// ===================================================================

		public function print_tag() {
			if ( ! $this->applies() ) {
				return;
			}
			echo $this->tag_html(); // phpcs:ignore WordPress.Security.EscapeOutput
		}

		/**
		 * Consent Mode v2, denied by default in the EEA and UK only.
		 *
		 * Region-scoped rather than global: a blanket denial would zero out the
		 * analytics for the whole audience, and a blanket grant is not lawful
		 * for European visitors. Google resolves the region at its end, so no
		 * geo lookup is needed here.
		 *
		 * Call gtag('consent','update',…) from whatever banner you add later and
		 * European data starts flowing. Until then those visitors are counted
		 * only in Google's modelled, cookieless form.
		 */
		private function tag_html() {
			$id  = (string) get_option( self::OPT_ID, '' );
			$ctx = $this->resolve_context();

			$params = array();
			if ( $ctx['handle'] ) {
				$params['creator_handle'] = $ctx['handle'];
			}
			if ( $ctx['kind'] ) {
				$params['content_kind'] = $ctx['kind'];
			}

			$config = wp_json_encode( $params ? $params : new stdClass() );

			$eea = "['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IS','IE','IT','LV','LI','LT','LU','MT','NL','NO','PL','PT','RO','SK','SI','ES','SE','GB','CH']";

			return "\n<!-- " . self::MARKER . " -->\n"
				. '<script async src="https://www.googletagmanager.com/gtag/js?id=' . esc_attr( $id ) . '"></script>' . "\n"
				. "<script>\n"
				. "window.dataLayer=window.dataLayer||[];\n"
				. "function gtag(){dataLayer.push(arguments);}\n"
				. "gtag('consent','default',{"
				. "'ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied',"
				. "'analytics_storage':'denied','region':" . $eea . "});\n"
				. "gtag('consent','default',{'analytics_storage':'granted'});\n"
				. "gtag('js',new Date());\n"
				. "gtag('config','" . esc_js( $id ) . "'," . $config . ");\n"
				. "</script>\n"
				. '<!-- /' . self::MARKER . " -->\n";
		}

		// ===================================================================
		// Fallback for pages that never call wp_head()
		// ===================================================================

		public function maybe_buffer() {
			if ( ! $this->applies() ) {
				return;
			}
			if ( isset( $_SERVER['REQUEST_METHOD'] )
				&& 'GET' !== strtoupper( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) ) ) {
				return;
			}
			ob_start( array( $this, 'inject' ) );
		}

		/**
		 * @param string $html Full response body.
		 * @return string
		 */
		public function inject( $html ) {
			if ( ! is_string( $html ) || '' === $html ) {
				return $html;
			}
			// Already delivered through wp_head — the normal case.
			if ( false !== strpos( $html, self::MARKER ) ) {
				return $html;
			}
			// Never double-tag a page that already loads GA by some other route.
			if ( false !== strpos( $html, 'googletagmanager.com/gtag/js' ) ) {
				return $html;
			}
			// Complete HTML documents only.
			$head = stripos( $html, '</head>' );
			if ( false === $head || false === stripos( $html, '<html' ) ) {
				return $html;
			}

			// A missing tag costs a day of data. A fatal here costs the page.
			try {
				$tag = $this->tag_html();
			} catch ( \Throwable $e ) {
				return $html;
			}

			return substr( $html, 0, $head ) . $tag . substr( $html, $head );
		}
	}

	SML_GA4_Creator_V1::boot();
}
