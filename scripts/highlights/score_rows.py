"""The result of score_engine.py -> the rows scorebox.py reads.

usage: score_rows.py <engine.json> <out.json> [a serve time to print ...]

The games and the sets of a row are the engine's. The point score of a moment is given only where every way to count
its game (the winner of the game and the winners a person confirmed, confidence 1.0, held) gives the same score there.
Where the ways differ, the row has no "points", and scorebox.py draws sets and games only."""
import json, itertools, sys
src, dst = sys.argv[1], sys.argv[2]
E=json.load(open(src)); R=[r for r in E['points'] if r.get('serve_t')]
W=['0','15','30','40']
def words(a,b):
    if a>=3 and b>=3: return ['40','40'] if a==b else (['AD','40'] if a>b else ['40','AD'])
    return [W[min(a,3)],W[min(b,3)]]
def over(a,b,mode): return max(a,b)>=4 and (abs(a-b)>=2 or mode=='golden' or (mode=='star' and a+b==11))
def ways(n,fixed,winner):
    out=[]
    for ws in itertools.product((0,1),repeat=n):
        if any(f is not None and f!=w for f,w in zip(fixed,ws)): continue
        for mode in ('adv','golden','star'):
            a=b=0; ok=None
            for i,w in enumerate(ws):
                a+=w==0; b+=w==1
                if over(a,b,mode): ok=(i==n-1 and (0 if a>b else 1)==winner); break
            if ok: out.append(ws); break
    return out
games=[]
for r in R:
    k=(r['set'],tuple(r['before']['games']),r['server'])
    if not games or games[-1][0]!=k: games.append((k,[]))
    games[-1][1].append(r)
rows=[]; shown=0
for gi,(k,g) in enumerate(games):
    n=len(g); winner=0 if sum(r['won']==0 for r in g)>sum(r['won']==1 for r in g) else 1
    fixed=[r['won'] if (r.get('confidence')==1.0) else None for r in g]
    ws=ways(n,fixed,winner) or [tuple(r['won'] for r in g)]
    nxt=games[gi+1][1][0]['before'] if gi+1<len(games) else None
    for i,r in enumerate(g):
        b=r['before']; bef={(sum(w==0 for w in x[:i]),sum(w==1 for w in x[:i])) for x in ws}
        aft={(sum(w==0 for w in x[:i+1]),sum(w==1 for w in x[:i+1])) for x in ws}
        st={'serving':b['serving'],'sets':b['sets'],'games':b['games']}
        if len(bef)==1: st['points']=words(*next(iter(bef))); shown+=1
        if i==n-1:
            if nxt: en={'serving':None,'sets':nxt['sets'],'games':nxt['games'],'points':['0','0']}
            else:
                s2=list(b['sets']); s2[winner]+=1; en={'serving':None,'sets':s2,'games':[0,0],'points':['0','0']}
        else:
            en={'serving':b['serving'],'sets':b['sets'],'games':b['games']}
            if len(aft)==1 and 'points' in st: en['points']=words(*next(iter(aft)))
        rows.append({'serve_t':r['serve_t'],'dead_t':r.get('dead_t'),'won':r['won'],'sure':True,'before':st,'after':en})
json.dump({'pairs':E['pairs'],'final':E['final'],'verdict':'agrees with the final score' if E['ok'] else 'does NOT agree','points':rows},open(dst,'w'),indent=1)
print(len(rows),'points;',shown,'with a sure point score before them')
for t in [float(x) for x in sys.argv[3:]]:
    r=min(rows,key=lambda q:abs(q['serve_t']-t)); print(round(t),r['won'],r['before'],'->',r['after'])
