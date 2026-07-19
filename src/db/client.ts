import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { RelayConfig } from "../config.ts";

export function createSupabaseClient(
  config: RelayConfig["supabase"],
): SupabaseClient {
  return createClient(config.url, config.secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
