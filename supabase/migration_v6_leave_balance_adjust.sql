-- =============================================================
-- Migration v6: Leave balance +/- adjustment
--
-- Adds adjust_leave_balance(), a companion to set_leave_balance()
-- that adds/subtracts a delta against the stored allowance instead
-- of requiring the caller to know and re-type the running total.
-- The arithmetic happens in SQL against the stored row (not a value
-- read back into the client), so concurrent adjustments can't
-- clobber each other. Clamped at 0.
--
-- Idempotent — safe to re-run.
-- =============================================================

CREATE OR REPLACE FUNCTION public.adjust_leave_balance(
  p_employees UUID[], p_category UUID, p_delta NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.my_has_role('hr_manage_policies') OR public.my_has_role('it')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  INSERT INTO public.leave_balances (employee_id, category_id, allowance)
  SELECT unnest(p_employees), p_category, GREATEST(0, p_delta)
  ON CONFLICT (employee_id, category_id)
  DO UPDATE SET allowance = GREATEST(0, public.leave_balances.allowance + p_delta), updated_at = NOW();
END;
$$;
