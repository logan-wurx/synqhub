"""sitemap_find.py <domain> <regex> [max_sitemaps]: product pages of a maker's own site whose URL matches the regex, read from its
sitemaps (robots.txt "Sitemap:" lines, else /sitemap.xml; sitemap indexes are followed). Cached like every other fetch; prints one URL per line."""
import re, sys
from common import fetch

domain, pat = sys.argv[1], re.compile(sys.argv[2], re.I)
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 40


def get(url):
    try:
        return fetch(url, text=True, timeout=40)
    except Exception as e:
        print("  (failed)", url[:90], str(e)[:60], file=sys.stderr)
        return ""


roots = re.findall(r"(?im)^sitemap:\s*(\S+)", get(f"https://{domain}/robots.txt")) or [f"https://{domain}/sitemap.xml"]
seen, todo, hits = set(), list(roots), []
while todo and len(seen) < limit:
    sm = todo.pop(0)
    if sm in seen:
        continue
    seen.add(sm)
    body = get(sm)
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body)
    if "<sitemapindex" in body:
        # Product sitemaps first: they are what we want, and big sites have hundreds of others.
        todo = sorted(locs, key=lambda u: (0 if re.search(r"product", u, re.I) else 1)) + todo
        continue
    hits += [u.replace("&amp;", "&") for u in locs if pat.search(u)]
for u in sorted(set(hits)):
    print(u)
print(f"[{len(seen)} sitemaps read, {len(set(hits))} matches]", file=sys.stderr)
