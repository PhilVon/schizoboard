//! What a page says it is — T-289, T-290, Q-304.
//!
//! Most of the sources worth pasting are not files. An archive.org item, a
//! Wikimedia Commons file page, a YouTube watch page and a Spotify track are all
//! *pages about* something, and the address somebody copies is the page's. A
//! direct media URL is already handled a layer up (`app/paste.ts` fetches
//! anything whose extension names a file this board can hold); this is the
//! question asked of everything else.
//!
//! **Q-304 chose one rule over a list of sites.** Open Graph is a convention
//! every one of those four already follows, along with most of the web, so a
//! single reading serves all of them and the next one nobody has thought of.
//! The rejected alternative was a per-site table — an archive.org metadata call,
//! a Commons API call, a YouTube oEmbed call — which is more accurate on exactly
//! four sites and is four scrapers that rot silently the day any of them changes
//! a field name.
//!
//! ## What is trusted, and what is not
//!
//! Nothing here decides what a file *is*. It reads what a page *claims*, and a
//! claim is worth acting on only in the two ways below.
//!
//! - **`og:image` is a lead, not a picture.** It is handed to the same fetch
//!   every pasted image URL goes through, and the store sniffs the bytes that
//!   come back. A page claiming its image is a PDF gets a folder, because the
//!   bytes said so.
//! - **`og:video` and `og:audio` are taken only when the page also declares a
//!   type this board can hold.** That distinction is the whole of T-290. A
//!   YouTube watch page *does* carry an `og:video`, and it is
//!   `https://www.youtube.com/embed/…` with the type `text/html` — a player, not
//!   a film. Taking it would hang a VHS on the wall that cannot play, which is
//!   the object T-290 exists to forbid. So the rule is not "does it have a
//!   video" but "does it say the video is a video".
//!
//! ## Why the scan and not an HTML parser
//!
//! Four attributes out of a `<head>` against a full HTML5 tree builder and its
//! dependency graph. The scan below is deliberately narrow — it finds `<meta>`
//! elements and reads their attributes, and it has no opinion about anything
//! else on the page, because there is nothing else here worth having an opinion
//! about. It cannot be *wrong* in an interesting way: an attribute it fails to
//! read is a card with one field missing, and a card with no fields at all is a
//! note with a URL on it, which is what the paste did before any of this.
//!
//! (A markdown reader — T-337 — is a separate crate and not this one. It wants
//! an event stream it can turn into runs, and a parser that renders to HTML
//! would need *this* kind of machinery to get back out again.)

/// What a page says about itself. Every field is absent far more often than not.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// `og:title`, falling back to the document's own `<title>`.
    pub title: Option<String>,
    /// `og:site_name` — "YouTube", "Internet Archive".
    pub site_name: Option<String>,
    /// `og:image`, absolute. A lead to follow, not a picture.
    pub image: Option<String>,
    /// A film or a recording the page declares *and gives a media type for*.
    pub media: Option<Media>,
}

/// A media file a page names, with the type it claims for it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub url: String,
    /// Never `text/html`: see the module note on what T-290 turns on.
    pub mime: String,
}

/// Read a page's Open Graph card out of its markup.
///
/// Total: markup this cannot make sense of yields an empty [`Card`], which the
/// caller reads as "there is nothing here to make an object out of".
pub fn card(html: &str) -> Card {
    let mut title = None;
    let mut og_title = None;
    let mut site_name = None;
    let mut image = None;
    let mut video = None;
    let mut video_type = None;
    let mut audio = None;
    let mut audio_type = None;

    for tag in elements(html, "meta") {
        let Some(key) = tag.attr("property").or_else(|| tag.attr("name")) else {
            continue;
        };
        let Some(content) = tag.attr("content") else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        // First wins. A page may repeat a property — several `og:image`s is the
        // documented way to offer alternatives — and the first is the one the
        // page put first.
        let slot = match key.to_ascii_lowercase().as_str() {
            "og:title" => &mut og_title,
            "og:site_name" => &mut site_name,
            "og:image" | "og:image:url" | "og:image:secure_url" => &mut image,
            "og:video" | "og:video:url" | "og:video:secure_url" => &mut video,
            "og:video:type" => &mut video_type,
            "og:audio" | "og:audio:url" | "og:audio:secure_url" => &mut audio,
            "og:audio:type" => &mut audio_type,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(content.trim().to_string());
        }
    }

    if let Some(text) = title_element(html) {
        title = Some(text);
    }

    Card {
        title: og_title.or(title),
        site_name,
        image: image.filter(|url| is_absolute(url)),
        // Video before audio: a page that declares both is a page with a film on
        // it, and the film is the thing somebody came for.
        media: holdable(video, video_type).or_else(|| holdable(audio, audio_type)),
    }
}

/// Read a podcast feed's newest episode as a card — T-289.
///
/// The fourth source in the task, and the only one that is neither a file nor a
/// page: a feed is a *list*, and what somebody pasting one wants on the wall is
/// the episode, not the list. RSS carries the file outright —
/// `<enclosure url="…" type="audio/mpeg">` is a plain address to a plain mp3,
/// which is what makes podcasts the one popular audio source needing no
/// scraping and no player.
///
/// **The first enclosure, which is the newest episode by convention and not by
/// guarantee.** Feeds are published newest-first and every reader in the world
/// relies on it, but nothing in the format says so — a feed that is ordered the
/// other way puts its oldest episode on the board, and that is a wrong episode
/// rather than a wrong kind of object. Taking all of them was the alternative
/// and it is worse: pasting one address and getting two hundred cassettes is
/// not something anybody meant.
///
/// The same media rule as a page's: the enclosure has to say it is audio or
/// video. A feed enclosing a PDF newsletter is a feed this does not answer for.
pub fn feed(xml: &str) -> Card {
    let media = elements(xml, "enclosure")
        .into_iter()
        .find_map(|tag| holdable(tag.attr("url"), tag.attr("type")))
        // Atom spells the same thing as a link with a relation.
        .or_else(|| {
            elements(xml, "link")
                .into_iter()
                .filter(|tag| {
                    tag.attr("rel")
                        .is_some_and(|rel| rel.eq_ignore_ascii_case("enclosure"))
                })
                .find_map(|tag| holdable(tag.attr("href"), tag.attr("type")))
        });
    Card {
        // A feed's first `<title>` is the channel's — the podcast, rather than
        // the episode. That is the right one: it is what somebody would call
        // the thing they just put on the board.
        title: title_element(xml),
        site_name: None,
        // Deliberately not `<itunes:image>` or `<image><url>`. Cover art is not
        // a still of the episode, and a printed still is what this board makes
        // when it could NOT get the file — here it got the file.
        image: None,
        media,
    }
}

/// A declared media file, but only when the page also says it is media.
///
/// **The type is required rather than guessed**, and this is the line T-290
/// stands on. A watch page declares `og:video` pointing at its own embed player
/// with the type `text/html`; guessing from the URL, or taking it because the
/// property is called video, hangs a tape on the wall that cannot play. A page
/// that will not say what its video is does not get to have one here.
fn holdable(url: Option<String>, declared: Option<String>) -> Option<Media> {
    let url = url.filter(|url| is_absolute(url))?;
    let mime = declared?.trim().to_ascii_lowercase();
    let mime = mime.split(';').next().unwrap_or(&mime).trim().to_string();
    if !(mime.starts_with("video/") || mime.starts_with("audio/")) {
        return None;
    }
    Some(Media { url, mime })
}

/// Absolute `http(s)` only, refused rather than resolved.
///
/// The same answer the redirect walk gives a relative `Location`, for the same
/// reason: joining URLs correctly is a parser's job, and being wrong about it
/// means fetching an address nobody checked.
fn is_absolute(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The document's own `<title>`, as the fallback `og:title` rarely needs.
fn title_element(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let gt = lower[open..].find('>')? + open + 1;
    let close = lower[gt..].find("</title>")? + gt;
    let text = decode_entities(html.get(gt..close)?);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// One element's raw attribute text.
struct Attrs<'a>(&'a str);

impl Attrs<'_> {
    /// The value of an attribute, in either kind of quotes or none at all.
    fn attr(&self, name: &str) -> Option<String> {
        let lower = self.0.to_ascii_lowercase();
        let mut from = 0;
        while let Some(at) = lower[from..].find(name) {
            let start = from + at;
            from = start + name.len();
            // A whole attribute name, not the tail of another one: `property`
            // must not match inside `data-property`.
            let before = html_before(&lower, start);
            if !before {
                continue;
            }
            let rest = lower[from..].trim_start();
            if !rest.starts_with('=') {
                continue;
            }
            let eq = from + lower[from..].find('=')? + 1;
            let value = self.0.get(eq..)?.trim_start();
            let (quote, body) = match value.chars().next()? {
                q @ ('"' | '\'') => (Some(q), value.get(1..)?),
                _ => (None, value),
            };
            let end = match quote {
                Some(q) => body.find(q)?,
                None => body
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .unwrap_or(body.len()),
            };
            // Decoded here, because *every* attribute value in HTML and XML is
            // entity-encoded and there is no caller for which that is not true.
            // Doing it at one caller instead is what let a real podcast feed
            // through with `&amp;` still in its enclosure URL — a query string
            // with the wrong parameter names, fetched, and blamed on the feed.
            return Some(decode_entities(body.get(..end)?));
        }
        None
    }
}

/// Is the character before this position a boundary rather than a name char?
fn html_before(lower: &str, at: usize) -> bool {
    match lower[..at].chars().next_back() {
        None => true,
        Some(c) => c.is_whitespace() || c == '<',
    }
}

/// Every `<name …>` element in the markup, as raw attribute text.
///
/// Written for `<meta>` and generalised for `<enclosure>`, which is the same
/// question asked of a feed: both are elements whose whole content is their
/// attributes, and neither has children worth walking into.
fn elements<'a>(markup: &'a str, name: &str) -> Vec<Attrs<'a>> {
    let lower = markup.to_ascii_lowercase();
    let open = format!("<{name}");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = lower[from..].find(&open) {
        let start = from + at;
        let past = start + open.len();
        // `<metadata>` is not `<meta>`.
        let after = lower[past..].chars().next();
        if !matches!(after, Some(c) if c.is_whitespace() || c == '/' || c == '>') {
            from = past;
            continue;
        }
        let end = match lower[start..].find('>') {
            Some(gt) => start + gt,
            // An unclosed tag at the end of a truncated document — the cap in
            // `fetch_page` makes this the ordinary case rather than a malformed
            // one, so it reads to the end rather than giving up.
            None => markup.len(),
        };
        if let Some(body) = markup.get(past..end) {
            out.push(Attrs(body));
        }
        from = end.max(past);
    }
    out
}

/// The five named entities and the numeric ones, which is what a title carries.
///
/// Not a general HTML entity table. An `&amp;` in a headline is the case this
/// exists for, and a page whose title needs `&eacute;` in 2026 has bigger
/// problems than this board — it will show as written rather than as intended,
/// which is a worse title and not a wrong object.
fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(semi) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let decoded = match entity.to_ascii_lowercase().as_str() {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => numeric(entity),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn numeric(entity: &str) -> Option<char> {
    let digits = entity.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse().ok()?,
    };
    char::from_u32(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_four_things_a_card_is_made_of() {
        let html = r#"<html><head>
            <meta property="og:title" content="The Wexford Tapes">
            <meta property="og:site_name" content="Internet Archive">
            <meta property="og:image" content="https://archive.org/services/img/wexford">
            <meta property="og:audio" content="https://archive.org/download/wexford/01.mp3">
            <meta property="og:audio:type" content="audio/mpeg">
        </head></html>"#;
        let card = card(html);
        assert_eq!(card.title.as_deref(), Some("The Wexford Tapes"));
        assert_eq!(card.site_name.as_deref(), Some("Internet Archive"));
        assert_eq!(
            card.image.as_deref(),
            Some("https://archive.org/services/img/wexford")
        );
        assert_eq!(
            card.media,
            Some(Media {
                url: "https://archive.org/download/wexford/01.mp3".into(),
                mime: "audio/mpeg".into(),
            })
        );
    }

    /// The whole of T-290, as an assertion. A watch page really does declare an
    /// `og:video`, and it really is a player.
    #[test]
    fn a_watch_page_offers_a_player_and_does_not_get_a_tape() {
        let html = r#"<head>
            <meta property="og:title" content="Never Gonna Give You Up">
            <meta property="og:image" content="https://i.ytimg.com/vi/x/hq.jpg">
            <meta property="og:video" content="https://www.youtube.com/embed/x">
            <meta property="og:video:type" content="text/html">
        </head>"#;
        let card = card(html);
        // A still and a title, which is the object T-290 asks for...
        assert_eq!(card.title.as_deref(), Some("Never Gonna Give You Up"));
        assert!(card.image.is_some());
        // ...and no film, because the page said the video is a page.
        assert_eq!(card.media, None);
    }

    #[test]
    fn a_video_with_no_declared_type_is_not_taken_either() {
        // Silence is not a claim. Guessing from the URL is what puts a tape on
        // the wall that cannot play.
        let html = r#"<meta property="og:video" content="https://e.com/reel.mp4">"#;
        assert_eq!(card(html).media, None);
    }

    #[test]
    fn reads_attributes_in_any_order_and_either_quote() {
        let html = "<meta content='Quoted Oddly' property=og:title>\
                    <meta content=\"https://e.com/a.png\" property='og:image'>";
        let card = card(html);
        assert_eq!(card.title.as_deref(), Some("Quoted Oddly"));
        assert_eq!(card.image.as_deref(), Some("https://e.com/a.png"));
    }

    #[test]
    fn falls_back_to_the_documents_own_title() {
        let html = "<html><head><title>  A page\n  nobody tagged </title></head>";
        assert_eq!(card(html).title.as_deref(), Some("A page nobody tagged"));
    }

    #[test]
    fn og_title_beats_the_title_element() {
        let html = "<head><title>Site — Section — Page</title>\
                    <meta property='og:title' content='Page'></head>";
        assert_eq!(card(html).title.as_deref(), Some("Page"));
    }

    #[test]
    fn decodes_the_entities_a_headline_actually_carries() {
        let html = r#"<meta property="og:title" content="Smith &amp; Co &#8212; &quot;the ledger&quot;">"#;
        assert_eq!(
            card(html).title.as_deref(),
            Some("Smith & Co — \"the ledger\"")
        );
    }

    #[test]
    fn refuses_a_relative_address_rather_than_resolving_it() {
        // The same answer the redirect walk gives, for the same reason.
        let html = "<meta property='og:image' content='/static/thumb.png'>";
        assert_eq!(card(html).image, None);
    }

    #[test]
    fn the_first_of_a_repeated_property_is_the_one_the_page_put_first() {
        let html = "<meta property='og:image' content='https://e.com/1.png'>\
                    <meta property='og:image' content='https://e.com/2.png'>";
        assert_eq!(card(html).image.as_deref(), Some("https://e.com/1.png"));
    }

    #[test]
    fn a_feed_hands_over_its_newest_episode() {
        let xml = r#"<rss version="2.0"><channel>
            <title>The Wexford Enquiry</title>
            <item>
              <title>Episode 12</title>
              <enclosure url="https://cdn.example.com/ep12.mp3" length="9" type="audio/mpeg"/>
            </item>
            <item>
              <title>Episode 11</title>
              <enclosure url="https://cdn.example.com/ep11.mp3" length="9" type="audio/mpeg"/>
            </item>
        </channel></rss>"#;
        let card = feed(xml);
        assert_eq!(card.title.as_deref(), Some("The Wexford Enquiry"));
        assert_eq!(
            card.media,
            Some(Media {
                url: "https://cdn.example.com/ep12.mp3".into(),
                mime: "audio/mpeg".into(),
            })
        );
        // No cover art: it got the file, so there is no printed still to make.
        assert_eq!(card.image, None);
    }

    /// Found on a live feed, not in a fixture. NPR's enclosure URL is a
    /// tracking redirect with a query string, and every `&` in it arrives as
    /// `&amp;` — which is what an XML attribute containing an ampersand looks
    /// like. Fetching it verbatim asks for parameters nobody has.
    #[test]
    fn an_ampersand_in_an_enclosure_url_is_an_ampersand() {
        let xml = r#"<rss><channel><item><enclosure
            url="https://cdn.example.com/ep.mp3?a=1&amp;b=2&amp;c=3" type="audio/mpeg"/>
        </item></channel></rss>"#;
        assert_eq!(
            feed(xml).media.map(|m| m.url),
            Some("https://cdn.example.com/ep.mp3?a=1&b=2&c=3".to_string())
        );
    }

    #[test]
    fn an_entity_is_decoded_once_and_not_twice() {
        // A title that is *about* an entity — "&amp;amp;" is how a page writes
        // the five characters `&amp;`, and decoding it twice would silently
        // rewrite what somebody wrote.
        let html = r#"<meta property="og:title" content="Write &amp;amp; for an ampersand">"#;
        assert_eq!(
            card(html).title.as_deref(),
            Some("Write &amp; for an ampersand")
        );
    }

    #[test]
    fn an_atom_feed_spells_it_as_a_link_and_is_read_the_same_way() {
        let xml = r#"<feed><title>The Wexford Enquiry</title><entry>
            <link rel="alternate" href="https://example.com/ep12" type="text/html"/>
            <link rel="enclosure" href="https://cdn.example.com/ep12.m4a" type="audio/mp4"/>
        </entry></feed>"#;
        let card = feed(xml);
        assert_eq!(card.media.as_ref().map(|m| m.mime.as_str()), Some("audio/mp4"));
        // And the alternate link, which is a web page, is not mistaken for one.
        assert_eq!(
            card.media.map(|m| m.url),
            Some("https://cdn.example.com/ep12.m4a".to_string())
        );
    }

    #[test]
    fn a_feed_enclosing_something_that_is_not_media_hands_over_nothing() {
        let xml = r#"<rss><channel><item>
            <enclosure url="https://e.com/newsletter.pdf" type="application/pdf"/>
        </item></channel></rss>"#;
        assert_eq!(feed(xml).media, None);
    }

    #[test]
    fn a_page_with_nothing_to_say_says_nothing() {
        assert_eq!(card("<html><body><p>hello</p></body></html>"), Card::default());
        assert_eq!(card(""), Card::default());
    }

    #[test]
    fn is_not_fooled_by_names_that_merely_contain_the_ones_it_wants() {
        let html = "<metadata property='og:title' content='not a meta tag'>\
                    <meta data-property='og:title' data-content='nor this'>";
        assert_eq!(card(html).title, None);
    }

    #[test]
    fn a_truncated_page_still_gives_up_what_it_had() {
        // `fetch_page` caps the read, so the last tag is routinely cut in half.
        // What arrived whole must survive that.
        let html = "<meta property='og:title' content='Half a page'>\
                    <meta property='og:image' content='https://e.com/a.pn";
        assert_eq!(card(html).title.as_deref(), Some("Half a page"));
    }
}
