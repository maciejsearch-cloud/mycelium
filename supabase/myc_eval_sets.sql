-- Stałe zbiory testowe (generuje scripts/eval_sets.py)
insert into public.myc_eval_sets (model, n, sha) values
  ('fashion', 2000, 'a15bf7e1a53269979a2b6f0c56db63a1f08104647d4e9d42d52c3d42bad34ecf'),
  ('har', 2247, 'a618353013d64430ebbe94365483b993c30f8967cbe47b50896edc1975e7d8ae'),
  ('intent', 3500, '3f0727d7ea030c2a2b0d27a8b7f07aabfba55f88706cab3dff1ee973a2b3c3a2'),
  ('words', 1086, 'afe3eede2248804204861ed7a099a4ba902be508c2917876d06d993ff0d57181')
on conflict (model) do update set n = excluded.n, sha = excluded.sha;
