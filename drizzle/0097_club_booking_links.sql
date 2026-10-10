-- The directory's booking links (DECIDING rule 34): which platform each listed club books on, and
-- its public booking page, from data/clubs.json. Only rows the directory owns and nobody claimed, so
-- every value here replaces the directory's own older one (Bangkok Padel left MATCHi for Playtomic);
-- a value the file leaves null never clears one.
UPDATE "clubs" SET
  "booking_url" = coalesce(v.booking_url, "clubs"."booking_url"),
  "booking_platform" = coalesce(v.booking_platform, "clubs"."booking_platform"),
  "website" = coalesce(v.website, "clubs"."website"),
  "updated_at" = now()
FROM (VALUES
  ('blue-tree', 'https://www.matchi.se/facilities/bluetree', 'matchi', null),
  ('destination-padel-club', 'https://playtomic.com/clubs/destination-padel-club', 'playtomic', 'https://playtomic.com/clubs/destination-padel-club'),
  ('sensei-padel-phuket', 'https://playtomic.com/clubs/sensei-padel-phuket', 'playtomic', 'https://playtomic.com/clubs/sensei-padel-phuket'),
  ('ptp-club-phuket', 'https://playtomic.com/clubs/ptp-club-phuket', 'playtomic', 'https://playtomic.com/clubs/ptp-club-phuket'),
  ('kross-padel-on-nut', null, 'bookandgo', null),
  ('kross-padel-sky-club', null, 'bookandgo', null),
  ('bangkok-padel', 'https://playtomic.com/clubs/bangkok-padel', 'playtomic', 'https://playtomic.com/clubs/bangkok-padel'),
  ('bel-club-padel', 'https://playtomic.com/clubs/bel-club-22', 'playtomic', 'https://playtomic.com/clubs/bel-club-22'),
  ('the-padel-co-bkk', 'https://playtomic.com/clubs/the-padel-co', 'playtomic', 'https://playtomic.com/clubs/the-padel-co'),
  ('baan-padel', 'https://playtomic.com/clubs/baan-padel', 'playtomic', 'https://playtomic.com/clubs/baan-padel'),
  ('top-padel-bangkok', null, 'padelsociety', 'https://www.topkartbangkok.com/top-padel/'),
  ('sterling', 'https://book.sterlingbkk.com/', 'bookandgo', 'https://sterlingbkk.com/'),
  ('kross-padel-indoor', 'https://krosspadel.com/', 'bookandgo', 'https://krosspadel.com/'),
  ('padel-cnx', 'https://playtomic.com/clubs/padel-cnx', 'playtomic', 'https://playtomic.com/clubs/padel-cnx'),
  ('padel-of-thailand-hua-hin', 'https://www.matchi.se/facilities/padelofthailand', 'matchi', 'https://padelofthailand.com/'),
  ('pattaya-padel-club', null, 'padelsociety', 'http://pattayapadelclub.com/'),
  ('koh-tao-athletic-club', 'https://playtomic.com/clubs/koh-tao-athletic-club-sports-complex', 'playtomic', 'https://playtomic.com/clubs/koh-tao-athletic-club-sports-complex'),
  ('love-all-sports', 'https://playtomic.com/clubs/love-all-racquet-club', 'playtomic', 'https://playtomic.com/clubs/love-all-racquet-club'),
  ('madison-house-padel', 'https://playtomic.com/clubs/madison-house', 'playtomic', 'https://playtomic.com/clubs/madison-house'),
  ('mandala-racquet-club', null, 'playtomic', 'https://www.mandala.club/mandalaracquetclub'),
  ('mbp-sports', 'https://mbpsports.web.app/', 'bookandgo', 'https://mbpsports.web.app/'),
  ('padel-x-singapore', 'https://playtomic.com/clubs/padel-x-singapore', 'playtomic', 'https://playtomic.com/clubs/padel-x-singapore'),
  ('padelstation-chevrons', 'https://playtomic.com/clubs/padelstation-the-chevrons', 'playtomic', 'https://playtomic.com/clubs/padelstation-the-chevrons'),
  ('pickle-padel-movement', 'https://playtomic.com/clubs/pickle-padel-movement', 'playtomic', 'https://playtomic.com/clubs/pickle-padel-movement'),
  ('pop-padel', 'https://book.pop-padel.com/', 'playbypoint', 'https://book.pop-padel.com/'),
  ('prime-padel-dempsey', 'https://app.primepadelsport.com/', 'bookandgo', 'https://app.primepadelsport.com/'),
  ('prime-padel-havelock', 'https://app.primepadelsport.com/', 'bookandgo', 'https://app.primepadelsport.com/'),
  ('ricochet-padel-laguna', 'https://ricochet.podify.club/book/laguna-venue', 'podplay', 'https://ricochetpadel.com'),
  ('ricochet-padel-orchard', 'https://ricochet.podify.club/book', 'podplay', 'https://ricochetpadel.com'),
  ('ricochet-padel-sentosa', 'https://ricochet.podify.club/book', 'podplay', 'https://ricochetpadel.com'),
  ('skypark-arena-holland', 'https://playtomic.com/clubs/skypark-padel', 'playtomic', 'https://playtomic.com/clubs/skypark-padel'),
  ('the-cage-padel-tribe', 'https://playtomic.com/clubs/the-cage-padel-tribe', 'playtomic', 'https://playtomic.com/clubs/the-cage-padel-tribe'),
  ('the-padel-co-bugis', 'https://playtomic.com/clubs/the-padel-co-reserve', 'playtomic', 'https://playtomic.com/clubs/the-padel-co-reserve'),
  ('the-padel-co-changi', 'https://playtomic.com/clubs/the-padel-co-changi', 'playtomic', 'https://playtomic.com/clubs/the-padel-co-changi'),
  ('the-racket-co-tanjong-pagar', 'https://playtomic.com/clubs/the-racket-co-tanjong-pagar', 'playtomic', 'https://playtomic.com/clubs/the-racket-co-tanjong-pagar'),
  ('tsa-jalan-kayu', 'https://playtomic.com/clubs/tsa-jalan-kayu', 'playtomic', 'https://playtomic.com/clubs/tsa-jalan-kayu')
) AS v (slug, booking_url, booking_platform, website)
WHERE "clubs"."slug" = v.slug AND "clubs"."source" = 'directory' AND "clubs"."claimed_by" IS NULL;
