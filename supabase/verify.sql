-- L1.6 constraint probes. Each block attempts an INVALID insert; if it is
-- (wrongly) accepted we undo it and record FAIL, otherwise the violation -> PASS.
create temp table _probe(name text, result text) on commit drop;
do $$
declare u uuid := 'c4e8158e-dc13-42bc-a455-ec9545e01306';
begin
  begin
    insert into portfolio(user_id,symbol,strike,expiry,contracts,premium_received)
      values (u,'_TST',1,'2026-01-01',0,1);
    delete from portfolio where user_id=u and symbol='_TST';
    insert into _probe values('portfolio.contracts>0','FAIL: 0 accepted');
  exception when others then insert into _probe values('portfolio.contracts>0','PASS'); end;

  begin
    insert into portfolio(user_id,symbol,strike,expiry,contracts,premium_received,status)
      values (u,'_TST',1,'2026-01-01',1,1,'bogus');
    delete from portfolio where user_id=u and symbol='_TST';
    insert into _probe values('portfolio.status enum','FAIL: bogus accepted');
  exception when others then insert into _probe values('portfolio.status enum','PASS'); end;

  begin
    insert into analyses(user_id,symbol,mode) values (u,'_TST','bogus');
    delete from analyses where user_id=u and symbol='_TST';
    insert into _probe values('analyses.mode enum','FAIL: bogus accepted');
  exception when others then insert into _probe values('analyses.mode enum','PASS'); end;

  begin
    insert into analyses(user_id,symbol,verdict) values (u,'_TST','MAYBE');
    delete from analyses where user_id=u and symbol='_TST';
    insert into _probe values('analyses.verdict enum','FAIL: MAYBE accepted');
  exception when others then insert into _probe values('analyses.verdict enum','PASS'); end;

  begin
    insert into scrape_requests(user_id,status) values (u,'bogus');
    delete from scrape_requests where user_id=u and status='bogus';
    insert into _probe values('scrape_requests.status enum','FAIL: bogus accepted');
  exception when others then insert into _probe values('scrape_requests.status enum','PASS'); end;

  begin
    insert into portfolio(user_id,symbol,contracts,premium_received) values (u,'_TST',1,1);
    delete from portfolio where user_id=u and symbol='_TST';
    insert into _probe values('portfolio NOT NULL strike/expiry','FAIL: nulls accepted');
  exception when others then insert into _probe values('portfolio NOT NULL strike/expiry','PASS'); end;
end $$;
select name, result from _probe order by name;
