-- Harmonogram sprzątania kolejki (pg_cron w Supabase): co 5 minut.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'myc_sweep';
select cron.schedule('myc_sweep', '*/5 * * * *', $$select public.myc_sweep()$$);
