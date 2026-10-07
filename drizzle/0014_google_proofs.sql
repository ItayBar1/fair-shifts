ALTER TABLE "auth_account" ADD COLUMN "google_link_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_account" ADD COLUMN "proof_epoch" integer;--> statement-breakpoint
ALTER TABLE "auth_account" ADD COLUMN "needs_email_verification" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "google_subject" text;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "google_link_generation" integer;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "google_link_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Legacy Google rows deliberately retain needs_email_verification=true.
-- Hooks finish before the adapter INSERT. Lock and recheck at the actual write.
-- Refuse the row without a raw SQL exception that could log session credentials.
CREATE FUNCTION public.fs_google_account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE authority record;
BEGIN
  IF NEW.provider_id <> 'google' THEN RETURN NEW; END IF;
  SELECT security_epoch, google_link_generation, locked_at, deleted_at
    INTO authority FROM public.auth_user WHERE id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR authority.locked_at IS NOT NULL OR authority.deleted_at IS NOT NULL
     OR NEW.proof_epoch IS DISTINCT FROM authority.security_epoch
     OR NEW.google_link_generation IS DISTINCT FROM authority.google_link_generation
     OR NEW.needs_email_verification THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER google_account_proof BEFORE INSERT ON public.auth_account
FOR EACH ROW EXECUTE FUNCTION public.fs_google_account_guard();
--> statement-breakpoint
CREATE FUNCTION public.fs_session_proof_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE authority record;
BEGIN
  SELECT security_epoch, google_link_generation, locked_at, deleted_at
    INTO authority FROM public.auth_user WHERE id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR authority.locked_at IS NOT NULL OR authority.deleted_at IS NOT NULL
     OR NEW.security_epoch IS DISTINCT FROM authority.security_epoch THEN
    RETURN NULL;
  END IF;
  IF NEW.google_subject IS NOT NULL OR NEW.google_link_generation IS NOT NULL THEN
    IF NEW.google_subject IS NULL
       OR NEW.google_link_generation IS DISTINCT FROM authority.google_link_generation
       OR NOT EXISTS (SELECT 1 FROM public.auth_account
          WHERE user_id = NEW.user_id AND provider_id = 'google'
            AND account_id = NEW.google_subject
            AND google_link_generation = NEW.google_link_generation
            AND NOT needs_email_verification) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_proof BEFORE INSERT ON public.auth_session
FOR EACH ROW EXECUTE FUNCTION public.fs_session_proof_guard();
