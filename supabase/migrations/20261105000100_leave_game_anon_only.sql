-- Match the other entry points: callable by anon only.
revoke execute on function public.leave_game(uuid, text) from authenticated;
