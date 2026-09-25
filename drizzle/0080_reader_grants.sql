-- Generated from src/db/schema by src/lib/db/readonly.ts. Do not hand-edit: tests/readonly.test.ts compares the two.
--> statement-breakpoint
do $$ begin if not exists (select 1 from pg_roles where rolname = 'kicksmash_reader') then create role "kicksmash_reader" nologin; end if; end $$;
--> statement-breakpoint
grant "kicksmash_reader" to current_user;
--> statement-breakpoint
revoke all on all tables in schema public from "kicksmash_reader";
--> statement-breakpoint
grant usage on schema public to "kicksmash_reader";
--> statement-breakpoint
grant select ("actor_player_id", "created_at", "event_id", "id", "meta", "verb") on public."activity" to "kicksmash_reader";
--> statement-breakpoint
grant select ("answer", "created_at", "digested_at", "id", "language", "published_at", "question", "slug", "source_item_id", "title", "unpublished_at") on public."answers" to "kicksmash_reader";
--> statement-breakpoint
grant select ("agent", "calls", "created_at", "email", "id", "last_used_at", "name", "prefix", "revoked_at") on public."api_keys" to "kicksmash_reader";
--> statement-breakpoint
grant select ("club_slug", "created_at", "id", "kind", "name", "number", "position") on public."club_courts" to "kicksmash_reader";
--> statement-breakpoint
grant select ("active", "capacity", "club_slug", "cost", "courts", "created_at", "dow", "format", "id", "last_created_for", "lead_days", "level_max", "level_min", "time", "title", "type", "verified_only", "when_full") on public."club_slots" to "kicksmash_reader";
--> statement-breakpoint
grant select ("about", "added_by", "approved_at", "availability", "availability_at", "availability_kind", "availability_url", "booking_platform", "booking_url", "city", "claim_contact", "claim_decision", "claim_role", "claim_verified_at", "claimed_at", "claimed_by", "closes_at", "country", "courts", "courts_indoor", "courts_outdoor", "created_at", "founding", "map_url", "name", "notify_message_id", "opens_at", "province", "rejected_at", "slug", "source", "tz", "updated_at", "website", "wrap_sent_for") on public."clubs" to "kicksmash_reader";
--> statement-breakpoint
grant select ("coach_id", "created_at", "data_base64", "id", "kind", "mime") on public."coach_assets" to "kicksmash_reader";
--> statement-breakpoint
grant select ("coach_id", "created_at", "ends_at", "external_id", "id", "reason", "source", "starts_at") on public."coach_blocks" to "kicksmash_reader";
--> statement-breakpoint
grant select ("coach_id", "created_at", "player_id") on public."coach_managers" to "kicksmash_reader";
--> statement-breakpoint
grant select ("coach_id", "created_at", "ends_at", "id", "source", "starts_at") on public."coach_openings" to "kicksmash_reader";
--> statement-breakpoint
grant select ("archived_at", "coach_id", "created_at", "heads", "id", "minutes", "position", "price", "size", "valid_days") on public."coach_package_offers" to "kicksmash_reader";
--> statement-breakpoint
grant select ("accepted_at", "coach_id", "created_at", "note", "player_id", "status") on public."coach_students" to "kicksmash_reader";
--> statement-breakpoint
grant select ("city_slug", "created_at", "expires_at", "id", "level", "notified_at", "player_id", "when_note") on public."coach_wants" to "kicksmash_reader";
--> statement-breakpoint
grant select ("approve_new_bookings", "archived_at", "bio", "calendar_error", "calendar_synced_at", "club_names", "club_slugs", "court", "created_at", "currency", "cutoff_hours", "display_name", "founding_at", "founding_tz", "gcal_checked_at", "gcal_id", "gcal_status", "handle", "hours", "ical_url", "id", "is_public", "languages", "late_passes", "lesson_minutes", "min_notice_hours", "open_booking", "outside_hours_fee", "pay_at_club", "pay_link", "player_id", "price_four", "price_second_single", "price_second_two", "price_single", "price_three", "price_two", "promptpay_id", "qr_asset_id", "second_minutes", "teaches_level_max", "teaches_level_min", "tz", "updated_at", "whatsapp", "wrap_sent_for") on public."coaches" to "kicksmash_reader";
--> statement-breakpoint
grant select ("competition_id", "consolation", "created_at", "draw_status", "drawn_at", "format", "golden_point", "group_size", "groups_through", "id", "level_max", "level_min", "max_pairs", "name", "position", "qualifying_spots", "scoring_final", "scoring_group", "scoring_knockout") on public."competition_categories" to "kicksmash_reader";
--> statement-breakpoint
grant select ("bye", "category_id", "competition_id", "court_name", "created_at", "entered_by_player_id", "group_label", "id", "pair_a_id", "pair_b_id", "phase", "position", "reminded_at", "round", "scheduled_at", "score_a", "score_b", "source_a", "source_b", "status", "stream_url", "updated_at", "winner") on public."competition_matches" to "kicksmash_reader";
--> statement-breakpoint
grant select ("category_id", "checked_in_at", "competition_id", "created_at", "entered_by_player_id", "id", "p1_player_id", "p2_player_id", "paid", "position", "seed", "status", "wildcard", "withdrawn_at") on public."competition_pairs" to "kicksmash_reader";
--> statement-breakpoint
grant select ("city", "court_names", "created_at", "day_end", "day_start", "ends_on", "entry_note", "id", "max_categories_per_player", "name", "organizer_player_id", "series_tag", "slug", "starts_on", "status", "tz", "updated_at", "venue_name", "venue_slug") on public."competitions" to "kicksmash_reader";
--> statement-breakpoint
grant select ("city_slug", "created_at", "expires_at", "from_time", "id", "notified_at", "on_date", "player_id", "to_time", "venue_slug", "weekday") on public."demand_signals" to "kicksmash_reader";
--> statement-breakpoint
grant select ("channel_id", "complete_noted_at", "created_at", "event_id", "id", "kind", "message_id", "rendered", "updated_at") on public."discord_cards" to "kicksmash_reader";
--> statement-breakpoint
grant select ("channel_id", "created_at", "group_id", "guild_id", "guild_name", "last_message_id", "left_at", "listen", "locale", "name", "tz", "venue_name") on public."discord_channels" to "kicksmash_reader";
--> statement-breakpoint
grant select ("attempts", "consumed_at", "created_at", "email", "expires_at", "id") on public."email_codes" to "kicksmash_reader";
--> statement-breakpoint
grant select ("address", "first_at", "kind", "last_at", "marked_at", "reason", "soft_count") on public."email_marks" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "email") on public."email_opt_outs" to "kicksmash_reader";
--> statement-breakpoint
grant select ("count", "fingerprint", "first_at", "fix_note", "fixed_at", "kind", "last_at", "message", "path", "stack") on public."error_events" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "data_base64", "event_id", "mime", "uploaded_by_player_id") on public."event_photos" to "kicksmash_reader";
--> statement-breakpoint
grant select ("booking_url", "capacity", "club_slot_id", "code", "cost", "court", "court_names", "courts", "created_at", "creator_player_id", "discord_reminder_sent_at", "format", "games_to", "group_id", "ics_sequence", "id", "level_max", "level_min", "level_verified_only", "levels_applied_at", "line_reminder_sent_at", "note", "pay_note", "points_per_match", "public_listing", "push_reminder_sent_at", "refill_notice_at", "score_locked_by_creator", "score_reminder_2_at", "score_reminder_sent", "series_id", "standings", "starts_at", "status", "telegram_reminder_sent_at", "title", "type", "tz", "venue_map_url", "venue_name", "venue_slug", "wants_notice_at", "when_full") on public."events" to "kicksmash_reader";
--> statement-breakpoint
grant select ("actor_player_id", "at", "channel", "city", "code", "data", "id", "kind", "subject_id", "subject_type", "venue_slug") on public."facts" to "kicksmash_reader";
--> statement-breakpoint
grant select ("assessment", "context", "created_at", "discord_channel_id", "discord_guild_id", "discord_user_id", "email", "email_message_id", "id", "locale", "messages_sent", "name", "player_id", "pr_url", "public_name", "public_summary", "replied_at", "reply_text", "role", "shipped_at", "source", "status", "telegram_chat_id", "telegram_message_id", "telegram_thread_id", "telegram_user_id", "text", "verdict") on public."feedback" to "kicksmash_reader";
--> statement-breakpoint
grant select ("group_id", "joined_at", "player_id", "role") on public."group_members" to "kicksmash_reader";
--> statement-breakpoint
grant select ("archived_at", "capacity", "code", "court", "created_at", "creator_player_id", "id", "level_max", "level_min", "name", "recur_dow", "recur_last_created_for", "recur_lead_days", "recur_time", "type", "tz", "venue_map_url", "venue_name", "when_full") on public."groups" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "decided_at", "decided_by_player_id", "event_id", "id", "level", "player_id", "status") on public."join_requests" to "kicksmash_reader";
--> statement-breakpoint
grant select ("amount", "closed_at", "coach_id", "created_at", "currency", "expires_at", "heads", "id", "late_passes_used", "low_reminded_at", "minutes", "note", "offer_id", "paid_at", "size", "student_player_id", "used") on public."lesson_packages" to "kicksmash_reader";
--> statement-breakpoint
grant select ("coach_id", "created_at", "heads", "id", "lesson_id", "minutes", "note", "resolved_at", "starts_at", "status", "student_player_id") on public."lesson_requests" to "kicksmash_reader";
--> statement-breakpoint
grant select ("coach_id", "created_at", "id", "offer_expires_at", "offered_at", "offered_lesson_id", "resolved_at", "slot_starts_at", "status", "student_player_id", "week_start") on public."lesson_waitlist" to "kicksmash_reader";
--> statement-breakpoint
grant select ("amount", "cancelled_at", "coach_id", "comp_reason", "comped_at", "consumed", "court", "created_at", "created_by_player_id", "external_id", "free_pass", "heads", "id", "kind", "minutes", "note", "package_id", "paid_at", "paid_claimed_at", "reminded_at", "slip_asset_id", "source", "starts_at", "status", "student_player_id", "venue_slug") on public."lessons" to "kicksmash_reader";
--> statement-breakpoint
grant select ("club_slug", "coach_id", "created_at", "decided_at", "decided_by_player_id", "decided_level", "event_id", "id", "level", "player_id", "status") on public."level_checks" to "kicksmash_reader";
--> statement-breakpoint
grant select ("complete_noted_at", "created_at", "event_id", "id", "kind", "message_id", "rendered", "room_id", "updated_at") on public."line_cards" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "group_id", "left_at", "locale", "room_id", "type", "tz", "venue_name") on public."line_rooms" to "kicksmash_reader";
--> statement-breakpoint
grant select ("author", "body", "created_at", "decided_at", "draft", "draft_model", "draft_reason", "drafted_at", "external_id", "fetched_at", "id", "kind", "language", "last_error", "notified_at", "notify_message_id", "posted_at", "posted_reply_at", "reply_url", "source", "status", "thread_id", "title", "url") on public."listen_items" to "kicksmash_reader";
--> statement-breakpoint
grant select ("day", "key", "value") on public."metrics_daily" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "event_id", "id", "kind", "player_id", "value") on public."milestones" to "kicksmash_reader";
--> statement-breakpoint
grant select ("body", "counterpart_email", "counterpart_name", "created_at", "decided_at", "id", "in_reply_to", "kind", "last_error", "message_id", "moment", "not_before", "notified_at", "notify_message_id", "org", "resend_id", "sent_at", "status", "subject", "thread_key") on public."outreach" to "kicksmash_reader";
--> statement-breakpoint
grant select ("banter", "created_at", "discord_id", "discord_username", "display_name", "email", "email_notifications", "email_verified_at", "homescreen_at", "id", "level", "level_log", "level_source", "level_updated_at", "level_verified_at", "level_verified_by", "level_verified_level", "level_verified_source", "line_display_name", "line_id", "locale", "phone", "public_profile", "public_since", "public_slug", "ranking_opt_in", "recovery_email", "telegram_id", "telegram_username") on public."players" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "id", "last_seen_at", "player_id", "user_agent") on public."push_subscriptions" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "credits", "hash", "kind", "payload", "query") on public."research_cache" to "kicksmash_reader";
--> statement-breakpoint
grant select ("city", "domain", "emails", "extracted_at", "first_seen_at", "id", "instagram", "kind", "last_seen_at", "note", "phone", "query_key", "score", "seen", "snippet", "status", "title", "url") on public."research_finds" to "kicksmash_reader";
--> statement-breakpoint
grant select ("credits", "empty_streak", "key", "last_error", "last_run_at", "new_items", "results", "runs") on public."research_runs" to "kicksmash_reader";
--> statement-breakpoint
grant select ("entered_by_player_id", "event_id", "id", "set_number", "side_a", "side_b", "updated_at") on public."scores" to "kicksmash_reader";
--> statement-breakpoint
grant select ("active", "anchor_at", "booking_url", "capacity", "cost", "court_names", "courts", "created_at", "dow", "every", "format", "games_to", "id", "last_created_for", "lead_days", "level_max", "level_min", "level_verified_only", "name", "nth", "organizer_player_id", "points_per_match", "slug", "time", "tz", "updated_at", "venue_map_url", "venue_name", "venue_slug", "when_full") on public."series" to "kicksmash_reader";
--> statement-breakpoint
grant select ("event_id", "id", "invited_at", "invited_email", "invited_name", "invited_phone", "joined_at", "kind", "last_reminded_at", "paid_at", "paid_claimed_at", "player_id", "position", "status", "team") on public."slots" to "kicksmash_reader";
--> statement-breakpoint
grant select ("chat_id", "complete_noted_at", "created_at", "event_id", "id", "kind", "message_id", "rendered", "updated_at") on public."telegram_cards" to "kicksmash_reader";
--> statement-breakpoint
grant select ("chat_id", "created_at", "group_id", "left_at", "locale", "title", "type", "tz", "venue_name") on public."telegram_chats" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "event_id", "inline_message_id", "locale", "rendered", "updated_at") on public."telegram_inline_cards" to "kicksmash_reader";
--> statement-breakpoint
grant select ("a1", "a2", "b1", "b2", "court", "entered_by_player_id", "id", "round_id", "side_a", "side_b", "updated_at") on public."tournament_matches" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "event_id", "id", "resting", "round_number") on public."tournament_rounds" to "kicksmash_reader";
--> statement-breakpoint
grant select ("creator_player_id", "id", "last_used_at", "map_url", "name") on public."venues" to "kicksmash_reader";
--> statement-breakpoint
grant select ("attempts", "created_at", "delivered_at", "event", "id", "last_error", "last_status", "next_attempt_at", "payload", "webhook_id") on public."webhook_deliveries" to "kicksmash_reader";
--> statement-breakpoint
grant select ("created_at", "disabled_at", "events", "failures", "filter", "id", "key_id", "url") on public."webhooks" to "kicksmash_reader";
