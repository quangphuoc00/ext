// Hand-authored to match supabase/migrations/0001_init.sql.
// Regenerate with: npx supabase gen types typescript --project-id <ref> > contracts/src/database.types.ts

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type PortfolioStatus = "open" | "closed" | "assigned" | "expired";
export type AnalysisMode = "routine" | "dip_buy";
export type Verdict = "PASS" | "FAIL";
export type RequestStatus = "pending" | "running" | "done" | "error";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          user_id: string;
          cash: number;
          total_account_value: number | null;
          stagger_delay_ms: number;
          poll_interval_ms: number;
          stable_close_count: number;
          updated_at: string;
        };
        Insert: {
          user_id?: string;
          cash?: number;
          total_account_value?: number | null;
          stagger_delay_ms?: number;
          poll_interval_ms?: number;
          stable_close_count?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      stocks: {
        Row: {
          symbol: string;
          intrinsic_value: number | null;
          intrinsic_updated_at: string | null;
          yahoo_options: Json | null;
          yahoo_options_updated_at: string | null;
          optioncharts: Json | null;
          optioncharts_updated_at: string | null;
          yahoo_analysis: Json | null;
          yahoo_analysis_updated_at: string | null;
          finviz: Json | null;
          finviz_updated_at: string | null;
          updated_at: string;
        };
        Insert: {
          symbol: string;
          intrinsic_value?: number | null;
          intrinsic_updated_at?: string | null;
          yahoo_options?: Json | null;
          yahoo_options_updated_at?: string | null;
          optioncharts?: Json | null;
          optioncharts_updated_at?: string | null;
          yahoo_analysis?: Json | null;
          yahoo_analysis_updated_at?: string | null;
          finviz?: Json | null;
          finviz_updated_at?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["stocks"]["Insert"]>;
        Relationships: [];
      };
      macro_data: {
        Row: {
          metric: string;
          value: number | null;
          as_of: string | null;
          updated_at: string;
        };
        Insert: {
          metric: string;
          value?: number | null;
          as_of?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["macro_data"]["Insert"]>;
        Relationships: [];
      };
      watchlist: {
        Row: { id: string; user_id: string; symbol: string; created_at: string };
        Insert: { id?: string; user_id?: string; symbol: string; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["watchlist"]["Insert"]>;
        Relationships: [];
      };
      portfolio: {
        Row: {
          id: string;
          user_id: string;
          symbol: string;
          strike: number;
          expiry: string;
          contracts: number;
          premium_received: number;
          opened_at: string;
          status: PortfolioStatus;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          symbol: string;
          strike: number;
          expiry: string;
          contracts: number;
          premium_received: number;
          opened_at?: string;
          status?: PortfolioStatus;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["portfolio"]["Insert"]>;
        Relationships: [];
      };
      analyses: {
        Row: {
          id: string;
          user_id: string;
          symbol: string;
          mode: AnalysisMode | null;
          verdict: Verdict | null;
          score_pass: number | null;
          score_total: number | null;
          recommended_strike: number | null;
          recommended_expiry: string | null;
          why: string | null;
          decision: string | null;
          raw_response: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          symbol: string;
          mode?: AnalysisMode | null;
          verdict?: Verdict | null;
          score_pass?: number | null;
          score_total?: number | null;
          recommended_strike?: number | null;
          recommended_expiry?: string | null;
          why?: string | null;
          decision?: string | null;
          raw_response?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["analyses"]["Insert"]>;
        Relationships: [];
      };
      analysis_requests: {
        Row: {
          id: string;
          user_id: string;
          symbol: string;
          mode: AnalysisMode | null;
          status: RequestStatus;
          error: string | null;
          requested_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          symbol: string;
          mode?: AnalysisMode | null;
          status?: RequestStatus;
          error?: string | null;
          requested_at?: string;
          completed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["analysis_requests"]["Insert"]>;
        Relationships: [];
      };
      scrape_requests: {
        Row: {
          id: string;
          user_id: string;
          status: RequestStatus;
          error: string | null;
          requested_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          status?: RequestStatus;
          error?: string | null;
          requested_at?: string;
          completed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["scrape_requests"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      // Returns the deduplicated set of symbols across all users' watchlist +
      // portfolio (SECURITY DEFINER; see migration 0002). Callable by anon.
      all_tracked_symbols: {
        Args: Record<string, never>;
        Returns: { symbol: string }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
