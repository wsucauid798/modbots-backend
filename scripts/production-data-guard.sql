DO $$
DECLARE
  matches text;
BEGIN
  SELECT string_agg(id || ':' || display_name || ':' || coalesce(handle, ''), ', ')
  INTO matches
  FROM actors
  WHERE id IN ('realtime-human', 'smoke-human', 'desktop-user', 'smoke-chat-bot', 'smoke-mod-bot')
     OR lower(display_name) IN (
       'realtime human',
       'smoke test human',
       'smoke test chat bot',
       'smoke test mod bot',
       'desktop user',
       'renamed probe',
       'session probe',
       'replycheck',
       'web user',
       'handoff user'
     )
     OR lower(display_name) LIKE 'copilot test%'
     OR lower(display_name) LIKE 'addrprobe%'
     OR lower(display_name) LIKE 'oidcuser%'
     OR lower(display_name) LIKE 'logincheck%'
     OR lower(display_name) LIKE 'inline%'
     OR lower(display_name) LIKE 'stale%'
     OR lower(display_name) LIKE 'regress%'
     OR lower(handle) LIKE 'smoke-%'
     OR lower(handle) LIKE 'copilot%'
     OR lower(handle) LIKE 'oidcuser%'
     OR lower(handle) LIKE 'logincheck%'
     OR lower(handle) LIKE 'inline%'
     OR lower(handle) LIKE 'stale%'
     OR lower(handle) LIKE 'regress%';

  IF matches IS NOT NULL THEN
    RAISE EXCEPTION 'Production data guard failed. Dev or test actors found: %', matches;
  END IF;
END $$;

SELECT 'production data guard passed' AS result;
