// v4
import { useState, useMemo, useEffect, useCallback, useRef } from "react";

function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return width;
}

async function claudeFetch(body) {
  const r = await fetch("/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error(text.slice(0, 120)); }
}

// Shared recommendation engine used by both the manual search UI and the auto-recommend background job.
// Returns { recommendations: [...], note: "" } — each rec has title, author, year, why, similarity,
// genre, subgenre. Throws on API or parse failure.
async function fetchRecommendations({ books, profileName, ageGroup, query, maxTokens = 4000 }) {
  const loved      = books.filter(b=>b.loved||b.rating>=5).map(b=>b.title).join(", ");
  const lovedAuthors = [...new Set(books.filter(b=>b.loved||b.rating>=5).map(b=>b.author).filter(Boolean))];
  const lovedGenres  = [...new Set(books.filter(b=>b.loved||b.rating>=5).map(b=>b.subgenre||b.genre).filter(Boolean))];
  const reading    = books.filter(b=>getStatus(b)==="reading").map(b=>b.title).join(", ");
  const audience   = audienceInstruction(ageGroup);

  const sys = `You are an audiobook recommendation engine for ${profileName}. They listen exclusively on Audible.

${audience ?? "IMPORTANT: Recommend adult fiction audiobooks only. Interpret all queries in the context of adult literature — never recommend children's books, picture books, or middle-grade fiction unless explicitly requested."}

LOVED BOOKS: ${loved||"not yet established"}
LOVED AUTHORS: ${lovedAuthors.join(", ")||"not yet established"}
ENJOYED GENRES: ${lovedGenres.join(", ")||"not yet established — default to adult fiction"}
READING NOW: ${reading||"nothing"}

Only recommend real, well-known audiobooks you are confident exist.

Return JSON only, no markdown:
{"recommendations":[{"title":"","author":"","year":"","why":"one direct line","similarity":"most like: [title]","genre":"Science Fiction","subgenre":""}],"note":""}`;

  const d = await claudeFetch({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: sys,
    messages: [{ role: "user", content: query }]
  });

  if (d.error) throw new Error(d.error.message);
  const allText = (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
  const jsonStr = extractJSON(allText);
  if (!jsonStr) throw new Error("No JSON found in response");
  const parsed = JSON.parse(jsonStr);
  const recs = (parsed.recommendations||[]).filter(r => r.title && r.author);
  return { recommendations: recs, note: parsed.note ?? "" };
}

function extractJSON(txt) {
  let depth=0, start=-1, inStr=false, esc=false;
  for (let i=0;i<txt.length;i++) {
    const c=txt[i];
    if (esc){esc=false;continue;}
    if (c==='\\'&&inStr){esc=true;continue;}
    if (c==='"'){inStr=!inStr;continue;}
    if (inStr) continue;
    if (c==='{'){if(depth===0)start=i;depth++;}
    else if(c==='}'){depth--;if(depth===0&&start!==-1)return txt.slice(start,i+1);}
  }
  return null;
}

const SPECIAL_AUTHORS = ["V.E. Schwab", "V. E. Schwab", "Martha Wells", "Philip K. Dick", "Andy Weir", "Blake Crouch", "Neal Stephenson"];

function audienceInstruction(ageGroup) {
  if (ageGroup === "children") return "AUDIENCE: This library belongs to a child. Only recommend age-appropriate audiobooks for children. Exclude all teen, adult, or mature content — no violence, horror, romance, or adult themes of any kind.";
  if (ageGroup === "teens")    return "AUDIENCE: This library belongs to a teenager. Only recommend Young Adult (YA) audiobooks. Age-appropriate fantasy, sci-fi, adventure, and coming-of-age are welcome. Exclude explicit sexual content, extreme gore, and adult-only themes.";
  return null; // adult — no instruction needed
}

function getStatus(book) {
  if (!book.series || !book.books?.length) return book.status;
  const subs = book.books;
  if (subs.some(b => b.status === "reading"))    return "reading";
  if (subs.every(b => b.status === "read"))       return "read";
  if (subs.some(b => b.status === "wanttoread")) return "wanttoread";
  if (subs.some(b => b.status === "recommended")) return "recommended";
  return book.status;
}

function calcSeriesRating(book) {
  if (!book.series) return book.rating || 0;
  if (!book.books?.length) return 0;
  const rated = book.books.filter(b => (b.rating || 0) > 0);
  if (!rated.length) return 0;
  return Math.round(rated.reduce((s, b) => s + b.rating, 0) / rated.length * 10) / 10;
}

function isSpecial(author) {
  if (!author) return false;
  return SPECIAL_AUTHORS.some(sa => author.toLowerCase().includes(sa.split(" ").pop().toLowerCase()));
}

function Stars({ rating, onChange }) {
  const [hov, setHov] = useState(0);
  const show = hov || Math.min(rating || 0, 5);
  return (
    <span style={{ display: "inline-flex", gap: 1 }}>
      {[1,2,3,4,5].map(i => (
        <span key={i}
          onClick={onChange ? e => { e.stopPropagation(); onChange(i); } : undefined}
          onMouseEnter={() => onChange && setHov(i)}
          onMouseLeave={() => onChange && setHov(0)}
          style={{ fontSize: 19, cursor: onChange ? "pointer" : "default", color: i <= show ? "#f59e0b" : "var(--star-empty)", transition: "color 0.1s" }}>★</span>
      ))}
    </span>
  );
}

function Chip({ label, variant }) {
  const v = {
    read:        ["var(--chip-read-bg)",    "var(--chip-read-text)",    "var(--chip-read-border)"],
    reading:     ["var(--chip-reading-bg)", "var(--chip-reading-text)", "var(--chip-reading-border)"],
    want:        ["var(--chip-want-bg)",    "var(--chip-want-text)",    "var(--chip-want-border)"],
    recommended: ["var(--chip-rec-bg)",     "var(--chip-rec-text)",     "var(--chip-rec-border)"],
  }[variant] || ["var(--surface)", "var(--text-muted)", "var(--surface-mid)"];
  return <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", fontFamily: "monospace", background: v[0], color: v[1], border: `1px solid ${v[2]}` }}>{label}</span>;
}

function Modal({ book, onSave, onClose, seriesList, isSub, profileName }) {
  const isNew = !book?.id;
  const [f, setF] = useState(book || { title:"", author:"", genre:"Science Fiction", subgenre:"", rating:0, status:"read", series:false, loved:false, notes:"", targetSeriesId:"" });
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState(null);
  const s = (k,v) => setF(p => ({...p,[k]:v}));
  const inp = { width:"100%", padding:"6px 10px", borderRadius:4, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text)", fontSize:19, fontFamily:"monospace", outline:"none", boxSizing:"border-box" };
  const lbl = (t) => <div style={{ fontSize:16, color:"var(--text-muted)", fontFamily:"monospace", marginBottom:4 }}>{t}</div>;

  const lookupBook = async () => {
    if (!searchQ.trim()) return;
    setSearching(true); setSearchErr(null);
    try {
      const d = await claudeFetch({
        model:"claude-haiku-4-5-20251001", max_tokens:500,
        system:`Identify the most likely audiobook from the user's description. ${profileName} listens on Audible. Return JSON only, no markdown:
{"title":"","author":"","genre":"Science Fiction|Fantasy|Horror|Thriller|Mystery|Nonfiction|Memoir|Other","subgenre":"","series":false,"seriesName":""}
genre must be exactly one of: Science Fiction, Fantasy, Horror, Thriller, Mystery, Nonfiction, Memoir, Other.
subgenre: short descriptor like "Cyberpunk", "Space Opera", "Grimdark", "Near-Future", "High Fantasy", "Military Sci-Fi", "Time Travel", "Dystopian", "Supernatural", "Warhammer 40K", or similar.
series: true if the book is part of a series, false if standalone.
seriesName: name of the series if series is true, otherwise empty string.
If you cannot identify the book, return {"error":"not found"}.`,
        messages:[{role:"user", content:searchQ}]
      });
      if (d.error) { setSearchErr(d.error.message); setSearching(false); return; }
      const txt = d.content?.find(b=>b.type==="text")?.text||"";
      const parsed = JSON.parse(txt.replace(/```json|```/g,"").trim());
      if (parsed.error) { setSearchErr("Book not found."); setSearching(false); return; }
      setF(p => ({
        ...p,
        title: parsed.title || p.title,
        author: parsed.author || p.author,
        genre: parsed.genre || p.genre,
        subgenre: parsed.subgenre || p.subgenre,
      }));
      setSearchErr(null);
    } catch(e) { setSearchErr("Lookup failed."); }
    setSearching(false);
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:4000, padding:16 }}>
      <div style={{ background:"var(--bg)", border:"1px solid var(--border)", borderRadius:8, padding:28, width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:16 }}>
          <span style={{ fontSize:21, fontWeight:700, fontFamily:"'Georgia',serif", color:"var(--text)" }}>{book?.id ? "Edit Book" : "Add Book"}</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:25 }}>✕</button>
        </div>
        {isNew && (
          <div style={{ marginBottom:14 }}>
            {lbl("SEARCH")}
            <div style={{ display:"flex", gap:6 }}>
              <input
                value={searchQ} onChange={e=>setSearchQ(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&lookupBook()}
                placeholder="Title, author, or description..."
                style={{ ...inp, flex:1 }}
              />
              <button onClick={lookupBook} disabled={searching} style={{ padding:"6px 10px", borderRadius:4, border:"none", background:searching?"var(--surface-mid)":"#f59e0b", color:searching?"#f59e0b":"var(--bg)", fontWeight:700, fontSize:34, cursor:searching?"default":"pointer", display:"flex", alignItems:"center", justifyContent:"center", minWidth:44, lineHeight:1 }}>
                {searching
                  ? <span style={{ display:"inline-block", width:11, height:11, border:"2px solid #f59e0b", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/>
                  : "⌕"}
              </button>
            </div>
            {searchErr && <div style={{ fontSize:16, color:"var(--danger)", fontFamily:"monospace", marginTop:4 }}>{searchErr}</div>}
            <div style={{ borderBottom:"1px solid var(--surface-mid)", margin:"12px 0" }}/>
          </div>
        )}
        {[["TITLE","title"],["AUTHOR","author"],["SUBGENRE","subgenre"]].map(([l,k]) => (
          <div key={k} style={{ marginBottom:10 }}>{lbl(l)}<input value={f[k]||""} onChange={e=>s(k,e.target.value)} style={inp}/></div>
        ))}
        <div style={{ marginBottom:10 }}>{lbl("GENRE")}
          <select value={f.genre} onChange={e=>s("genre",e.target.value)} style={inp}>
            {["Science Fiction","Fantasy","Horror","Thriller","Mystery","Nonfiction","Memoir","Other"].map(g=><option key={g}>{g}</option>)}
          </select>
        </div>
        {!f.series && <div style={{ marginBottom:10 }}>{lbl("STATUS")}
          <select value={f.status} onChange={e=>s("status",e.target.value)} style={inp}>
            <option value="recommended">Recommended</option>
            <option value="read">Read</option>
            <option value="reading">Reading</option>
            <option value="wanttoread">Want to Read</option>
          </select>
        </div>}
        {f.status==="read" && !f.series && <div style={{ marginBottom:10 }}>{lbl("RATING")}<Stars rating={f.rating} onChange={v=>s("rating",v)}/></div>}
        <div style={{ display:"flex", gap:16, marginBottom:10 }}>
          {!isSub && (
            <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
              <input type="checkbox" checked={!!f.series} onChange={e=>{ s("series",e.target.checked); if(e.target.checked) s("targetSeriesId",""); }} style={{ accentColor:"#f59e0b" }}/>
              <span style={{ fontSize:18, color:"var(--text-muted)", fontFamily:"monospace" }}>Series</span>
            </label>
          )}
          <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
            <input type="checkbox" checked={!!f.loved} onChange={e=>s("loved",e.target.checked)} style={{ accentColor:"#f59e0b" }}/>
            <span style={{ fontSize:18, color:"var(--text-muted)", fontFamily:"monospace" }}>Loved ★</span>
          </label>
        </div>
        {isNew && !isSub && !f.series && seriesList?.length > 0 && (
          <div style={{ marginBottom:10 }}>{lbl("ADD TO SERIES")}
            <select value={f.targetSeriesId||""} onChange={e=>s("targetSeriesId",e.target.value)} style={inp}>
              <option value="">— Library (top level) —</option>
              {seriesList.map(sr=><option key={sr.id} value={sr.id}>{sr.title}</option>)}
            </select>
          </div>
        )}
        <div style={{ marginBottom:16 }}>{lbl("NOTES")}
          <textarea value={f.notes||""} onChange={e=>s("notes",e.target.value)} rows={2} style={{ ...inp, resize:"vertical" }}/>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={()=>onSave(f)} style={{ flex:1, padding:"8px", borderRadius:4, border:"none", background:"#f59e0b", color:"var(--accent-fg)", fontWeight:700, fontSize:19, fontFamily:"monospace", cursor:"pointer" }}>SAVE</button>
          <button onClick={onClose} style={{ padding:"8px 16px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:19, fontFamily:"monospace", cursor:"pointer" }}>CANCEL</button>
        </div>
      </div>
    </div>
  );
}

function Card({ book, onEdit, onDelete, onView }) {
  const sp = isSpecial(book.author);
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      onClick={book.series && onView ? ()=>onView() : undefined}
      style={{ background: book.series ? "linear-gradient(135deg,var(--bg),var(--surface))" : "var(--bg)", border:`1px solid ${menu ? "var(--text-muted)" : "var(--border)"}`, borderRadius:6, padding:"12px 14px", position:"relative", transition:"border-color 0.15s,transform 0.1s", cursor: book.series && onView ? "pointer" : "default" }}
      onMouseEnter={e=>{ if(!menu){ e.currentTarget.style.borderColor="var(--text-dim)"; e.currentTarget.style.transform="translateY(-1px)"; }}}
      onMouseLeave={e=>{ if(!menu){ e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.transform="translateY(0)"; }}}
    >
      {book.loved && <div style={{ position:"absolute", top:0, right:0, width:0, height:0, borderStyle:"solid", borderWidth:"0 16px 16px 0", borderColor:"transparent #f59e0b transparent transparent" }}/>}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:6 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:19, fontWeight:600, lineHeight:1.3, marginBottom:2, fontFamily:"'Georgia',serif", color:"var(--text)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
            {book.title}{book.series && <span style={{ color:"#f59e0b", fontSize:14, marginLeft:4 }}>series ›</span>}
          </div>
          <div style={{ fontSize:16, color:sp?"var(--special-author)":"var(--text-muted)", marginBottom:4 }}>{book.author}</div>
          <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
            <Chip label={getStatus(book)==="read"?"READ":getStatus(book)==="reading"?"READING":getStatus(book)==="recommended"?"REC":"WANT"} variant={getStatus(book)==="read"?"read":getStatus(book)==="reading"?"reading":getStatus(book)==="recommended"?"recommended":"want"}/>
            {calcSeriesRating(book)>0 && <Stars rating={calcSeriesRating(book)}/>}
            {book.subgenre && <span style={{ fontSize:14, color:"var(--text-muted)", fontFamily:"monospace" }}>{book.subgenre}</span>}
          </div>
        </div>
        <button onClick={e=>{ e.stopPropagation(); setMenu(m=>!m); setConfirming(false); }}
          style={{ background:"none", border:"none", color: menu ? "var(--text)" : "#f59e0b", cursor:"pointer", fontSize:27, fontWeight:700, padding:"0 4px", lineHeight:1, flexShrink:0 }}>⋮</button>
      </div>
      {menu && !confirming && (
        <div onClick={e=>e.stopPropagation()} style={{ marginTop:8, paddingTop:8, borderTop:"1px solid var(--surface-mid)", display:"flex", gap:6 }}>
          <button onClick={()=>{ setMenu(false); onEdit(); }} style={{ flex:1, padding:"5px 0", borderRadius:3, border:"1px solid var(--text-dimmer)", background:"transparent", color:"var(--text-muted)", fontSize:16, fontFamily:"monospace", cursor:"pointer", fontWeight:700, letterSpacing:"0.05em" }}>EDIT</button>
          <button onClick={()=>setConfirming(true)} style={{ flex:1, padding:"5px 0", borderRadius:3, border:"1px solid var(--danger-bg)", background:"transparent", color:"var(--danger)", fontSize:16, fontFamily:"monospace", cursor:"pointer", fontWeight:700, letterSpacing:"0.05em" }}>DELETE</button>
          <a href={`https://www.audible.com/search?keywords=${encodeURIComponent(`${book.title} ${book.author}`).replace(/%20/g,'+')}`} target="_blank" rel="noopener noreferrer" onClick={()=>setMenu(false)} title="Search Audible" style={{ padding:"5px 8px", borderRadius:3, border:"1px solid var(--border)", background:"transparent", cursor:"pointer", textDecoration:"none", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--text-dim)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/>
              <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
            </svg>
          </a>
          <button onClick={()=>setMenu(false)} style={{ padding:"5px 8px", borderRadius:3, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:16, fontFamily:"monospace", cursor:"pointer" }}>✕</button>
        </div>
      )}
      {menu && confirming && (
        <div onClick={e=>e.stopPropagation()} style={{ marginTop:8, paddingTop:8, borderTop:"1px solid var(--danger-bg)", display:"flex", gap:6, alignItems:"center" }}>
          <span style={{ flex:1, fontSize:16, color:"var(--danger)", fontFamily:"monospace" }}>Delete?</span>
          <button onClick={()=>{ setMenu(false); setConfirming(false); onDelete(); }} style={{ padding:"5px 12px", borderRadius:3, border:"none", background:"var(--danger-bg)", color:"var(--danger)", fontSize:16, fontFamily:"monospace", cursor:"pointer", fontWeight:700 }}>YES</button>
          <button onClick={()=>setConfirming(false)} style={{ padding:"5px 12px", borderRadius:3, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:16, fontFamily:"monospace", cursor:"pointer" }}>NO</button>
        </div>
      )}
    </div>
  );
}

function SeriesModal({ series, onClose, onUpdate, onDeleteBook, profileName }) {
  const [subModal, setSubModal] = useState(null);
  const sp = isSpecial(series.author);
  const subBooks = series.books || [];

  const persist = (next) => {
    onUpdate({ ...series, books: next });
  };

  const saveSubBook = (book) => {
    const b = book.id ? book : { ...book, id: `book-${Date.now()}` };
    const isNew = !subBooks.find(s=>s.id===b.id);
    const next = isNew ? [...subBooks, b] : subBooks.map(s=>s.id===b.id?b:s);
    persist(next);
    setSubModal(null);
  };

  const newBook = { id:"", title:"", author:series.author, genre:series.genre, subgenre:series.subgenre||"", status:"read", rating:0, loved:false };

  const statusColor = { read:"var(--chip-read-text)", reading:"var(--chip-reading-text)", wanttoread:"var(--chip-want-text)", recommended:"var(--chip-rec-text)" };
  const statusLabel = { read:"READ", reading:"READING", wanttoread:"WANT TO READ", recommended:"RECOMMENDED" };

  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.82)", display:"flex", alignItems:"flex-start", justifyContent:"center", zIndex:2000, overflowY:"auto", padding:"32px 16px" }}>
        <div style={{ background:"var(--bg)", border:"1px solid var(--border)", borderRadius:10, width:"100%", maxWidth:860, minHeight:200 }}>

          {/* Header */}
          <div style={{ padding:"16px 20px", borderBottom:"1px solid var(--surface-mid)", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ fontSize:27, fontWeight:700, fontFamily:"'Georgia',serif", color:sp?"var(--special-author)":"var(--text)", marginBottom:2 }}>{series.title}</div>
              <div style={{ fontSize:19, color:sp?"var(--special-author)":"var(--text-muted)" }}>{series.author}</div>
            </div>
            <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-dim)", fontSize:27, cursor:"pointer", padding:"0 4px" }}>✕</button>
          </div>

          {/* Series metadata */}
          <div style={{ padding:"14px 20px", borderBottom:"1px solid var(--border-subtle)", display:"flex", gap:16, flexWrap:"wrap", alignItems:"center" }}>
            <span style={{ fontSize:18, color:statusColor[series.status]||"var(--text-muted)", fontFamily:"monospace", fontWeight:700, letterSpacing:"0.08em" }}>{statusLabel[series.status]||series.status.toUpperCase()}</span>
            {calcSeriesRating(series)>0 && <Stars rating={calcSeriesRating(series)}/>}
            {series.loved && <span style={{ fontSize:16, color:"#f59e0b", fontFamily:"monospace", fontWeight:700, letterSpacing:"0.08em" }}>★ LOVED</span>}
            {series.genre && <span style={{ fontSize:16, color:"var(--text-dim)", fontFamily:"monospace" }}>{series.genre}{series.subgenre?` · ${series.subgenre}`:""}</span>}
            <span style={{ fontSize:16, color:"var(--text-dim)", fontFamily:"monospace" }}>{subBooks.length} book{subBooks.length!==1?"s":""}</span>
          </div>

          {/* Books section */}
          <div style={{ padding:"14px 20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <span style={{ fontSize:16, color:"var(--text-dim)", fontFamily:"monospace", letterSpacing:"0.08em" }}>BOOKS IN SERIES</span>
              <button onClick={()=>setSubModal({book:newBook})} style={{ fontSize:16, padding:"4px 10px", borderRadius:3, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontFamily:"monospace", cursor:"pointer", letterSpacing:"0.05em" }}>+ ADD BOOK</button>
            </div>
            {subBooks.length === 0
              ? <div style={{ fontSize:18, color:"var(--text-dim)", fontFamily:"monospace", padding:"20px 0", textAlign:"center" }}>No books added yet.</div>
              : <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:7 }}>
                  {subBooks.map(b=><Card key={b.id} book={b} onEdit={()=>setSubModal({book:b})} onDelete={()=>onDeleteBook(b.id)}/>)}
                </div>
            }
          </div>
        </div>
      </div>
      {subModal && <Modal book={subModal.book} onSave={saveSubBook} onClose={()=>setSubModal(null)} isSub={true} profileName={profileName}/>}
    </>
  );
}

function Recommend({ books, profileName, ageGroup, onAdd, onStatusChange }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState({});
  const existingTitles = new Set(books.map(b=>b.title.toLowerCase()));
  const lovedAuthors = [...new Set(books.filter(b=>b.loved||b.rating>=5).map(b=>b.author).filter(Boolean))];

  const go = async () => {
    if (!q.trim()) return;
    setLoading(true); setRes(null);
    onStatusChange?.({ text: "Searching for audiobook recommendations…", isError: false });
    try {
      const result = await fetchRecommendations({ books, profileName, ageGroup, query: q });
      result.recommendations = result.recommendations.filter(r => !existingTitles.has(r.title.toLowerCase()));
      setRes(result);
    } catch (e) {
      setRes({ error: true, msg: e.message });
      onStatusChange?.({ text: `Recommendation search failed: ${e.message}`, isError: true });
      setLoading(false); return;
    }
    onStatusChange?.(null);
    setLoading(false);
  };

  const handleAdd = (r) => {
    const id = r.title.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"");
    onAdd({ id, title:r.title, author:r.author, genre:"Science Fiction", subgenre:"", status:"wanttoread" });
    setAdded(a=>({...a,[r.title]:true}));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ fontSize:18, color:"var(--text-dim)", lineHeight:1.5 }}>Ask anything — describe a mood, genre, author, or a book you loved and want more of</div>
      <div style={{ display:"flex", gap:8 }}>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="What are you looking for?"
          style={{ flex:1, padding:"8px 12px", borderRadius:5, background:"var(--surface)", border:"1px solid var(--border)", color:"var(--text)", fontSize:19, fontFamily:"monospace", outline:"none" }}/>
        <button onClick={go} disabled={loading} style={{ padding:"8px 14px", borderRadius:5, border:"none", background:loading?"var(--surface-mid)":"#f59e0b", color:"var(--accent-fg)", fontWeight:700, fontSize:18, fontFamily:"monospace", cursor:loading?"default":"pointer", letterSpacing:"0.05em", minWidth:60, display:"flex", alignItems:"center", justifyContent:"center" }}>
          {loading
            ? <span style={{ display:"inline-block", width:12, height:12, border:"2px solid #f59e0b", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/>
            : "FIND"}
        </button>
      </div>
      {res?.error && <div style={{ color:"var(--danger)", fontSize:19 }}>Something went wrong{res.msg ? `: ${res.msg}` : "."}</div>}
      {res?.note && <div style={{ fontSize:18, color:"var(--text-muted)", fontStyle:"italic" }}>{res.note}</div>}
      {res?.recommendations?.length === 0 && <div style={{ fontSize:18, color:"var(--text-dim)" }}>No verified results found.</div>}
      {res?.recommendations?.map((r,i)=>(
        <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--surface-mid)", borderRadius:6, padding:"10px 12px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
            <div>
              <span style={{ fontSize:20, fontWeight:600, color:"var(--text)", fontFamily:"'Georgia',serif" }}>{r.title}</span>
              <span style={{ fontSize:18, color:"var(--text-muted)", marginLeft:8 }}>{r.author}</span>
              {r.year && <span style={{ fontSize:16, color:"var(--text-dim)", marginLeft:6 }}>{r.year}</span>}
            </div>
            <div style={{ display:"flex", gap:4, flexShrink:0 }}>
              <a href={`https://www.audible.com/search?keywords=${encodeURIComponent(r.title+' '+r.author).replace(/%20/g,'+')}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:16, padding:"2px 7px", borderRadius:3, background:"#f59e0b22", border:"1px solid #f59e0b55", color:"#f59e0b", fontFamily:"monospace", fontWeight:700, letterSpacing:"0.05em", textDecoration:"none", flexShrink:0 }}>AUDIBLE ↗</a>
            </div>
          </div>
          <div style={{ marginTop:5, fontSize:18, color:"var(--text-muted)", lineHeight:1.4 }}>{r.why}</div>
          <div style={{ marginTop:6, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ display:"flex", gap:12, alignItems:"center" }}>
              {r.similarity && <span style={{ fontSize:16, color:"var(--text-dim)" }}>↔ {r.similarity}</span>}
              <a href={`https://www.goodreads.com/search?q=${encodeURIComponent(r.title+' '+r.author)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:16, color:"#f59e0b", textDecoration:"none" }}>Goodreads ↗</a>
            </div>
            {!existingTitles.has(r.title.toLowerCase()) && (
              added[r.title]
                ? <span style={{ fontSize:16, color:"#4ade80", fontFamily:"monospace" }}>✓ ADDED</span>
                : <button onClick={()=>handleAdd(r)} style={{ fontSize:16, padding:"3px 8px", borderRadius:3, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontFamily:"monospace", cursor:"pointer", letterSpacing:"0.05em" }}>+ WANT TO READ</button>
            )}
          </div>
        </div>
      ))}
      {lovedAuthors.length > 0 && (
        <div style={{ marginTop:8, padding:12, background:"var(--surface)", borderRadius:6, border:"1px solid var(--border-subtle)" }}>
          <div style={{ fontSize:16, color:"var(--text-dim)", fontFamily:"monospace", marginBottom:6, letterSpacing:"0.08em" }}>LOVED AUTHORS</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {lovedAuthors.map(a=>(
              <span key={a} style={{ fontSize:18, padding:"2px 8px", borderRadius:3, background:"var(--special-bg)", color:"var(--special-author)", border:"1px solid var(--special-border)", fontFamily:"monospace" }}>{a}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const AGE_GROUPS = [
  { value: "adult",    label: "Adult" },
  { value: "teens",    label: "Teens" },
  { value: "children", label: "Children" },
];

function SettingsModal({ activeProfile, activeProfileName, ageGroup, onAgeGroupChange, onDeleteLibrary, onClose }) {
  const [confirming, setConfirming] = useState(false);
  const isProtected = activeProfile === "em";

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:4000, padding:16 }}>
      <div style={{ background:"var(--bg)", border:"1px solid var(--border)", borderRadius:8, padding:28, width:"100%", maxWidth:440 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
          <span style={{ fontSize:21, fontWeight:700, fontFamily:"'Georgia',serif", color:"var(--text)" }}>Settings</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:25 }}>✕</button>
        </div>

        {/* Age group */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:14, color:"var(--text-dim)", fontFamily:"monospace", letterSpacing:"0.08em", marginBottom:10 }}>PROFILE TYPE</div>
          <div style={{ display:"flex", gap:6 }}>
            {AGE_GROUPS.map(ag => (
              <button key={ag.value} onClick={() => onAgeGroupChange(ag.value)}
                style={{ flex:1, padding:"8px 0", borderRadius:4, border:"1px solid", fontWeight:700, fontSize:16, fontFamily:"monospace", cursor:"pointer", letterSpacing:"0.05em",
                  background: ageGroup===ag.value ? "var(--surface-mid)" : "transparent",
                  color:       ageGroup===ag.value ? "var(--text)"  : "var(--text-dim)",
                  borderColor: ageGroup===ag.value ? "var(--text-dim)"  : "var(--border)" }}>
                {ag.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ borderTop:"1px solid var(--surface-mid)", marginBottom:20 }}/>

        {!confirming ? (
          <>
            <button
              onClick={() => !isProtected && setConfirming(true)}
              disabled={isProtected}
              style={{ width:"100%", padding:"9px", borderRadius:4, border:`1px solid ${isProtected?"var(--surface-mid)":"var(--danger-bg)"}`, background:"transparent", color:isProtected?"var(--border)":"var(--danger)", fontWeight:700, fontSize:19, fontFamily:"monospace", cursor:isProtected?"not-allowed":"pointer", letterSpacing:"0.05em", marginBottom:8, textAlign:"left" }}>
              Delete {activeProfileName}'s Library{isProtected ? " — protected" : ""}
            </button>
            {isProtected && <div style={{ fontSize:16, color:"var(--text-dimmer)", fontFamily:"monospace", marginBottom:12 }}>The first library cannot be deleted.</div>}
            <button onClick={onClose} style={{ width:"100%", padding:"8px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:19, fontFamily:"monospace", cursor:"pointer" }}>Cancel</button>
          </>
        ) : (
          <>
            <div style={{ fontSize:19, color:"var(--danger)", fontFamily:"monospace", marginBottom:16, lineHeight:1.5 }}>
              Delete <strong>{activeProfileName}'s</strong> entire library? This cannot be undone.
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={onDeleteLibrary} style={{ flex:1, padding:"8px", borderRadius:4, border:"none", background:"var(--danger-bg)", color:"var(--danger)", fontWeight:700, fontSize:19, fontFamily:"monospace", cursor:"pointer" }}>YES, DELETE</button>
              <button onClick={()=>setConfirming(false)} style={{ flex:1, padding:"8px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:19, fontFamily:"monospace", cursor:"pointer" }}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function App({ onLock }) {
  const windowWidth = useWindowWidth();
  const isWide = windowWidth >= 1400;
  const isNarrow = windowWidth < 600;

  const [books, setBooks] = useState([]);
  const [ready, setReady] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [tab, setTab] = useState("library");
  const [filter, setFilter] = useState("all");
  const [genre, setGenre] = useState("all");
  const [search, setSearch] = useState("");
  const [minRating, setMinRating] = useState(0);
  const [sortBy, setSortBy] = useState("rating");
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [seriesModal, setSeriesModal] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null); // { text, isError }
  const [theme, setTheme] = useState(() => localStorage.getItem("lib_theme") || "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lib_theme", theme);
  }, [theme]);

  const PROFILES_KEY = "library-profiles";
  const activeProfileRef = useRef(null);

  const wsRead = async (key) => {
    const r = await window.storage.get(key).catch(() => null);
    return r ? JSON.parse(r.value) : null;
  };

  const wsWrite = async (key, data) => {
    const result = await window.storage.set(key, JSON.stringify(data));
    if (!result) throw new Error("storage returned null");
  };

  const booksKey = (profileId) => `${profileId}-library`;

  // Initial load: resolve profiles, then load books for the first profile
  useEffect(() => {
    (async () => {
      try {
        let profs = await wsRead(PROFILES_KEY);
        if (!profs || !profs.length) {
          // First run — seed with Em pointing at the existing row
          profs = [{ id: "em", name: "Em" }];
          await wsWrite(PROFILES_KEY, profs).catch(() => {});
        }
        setProfiles(profs);
        const first = profs[0];
        activeProfileRef.current = first.id;
        setActiveProfile(first.id);
        const stored = await wsRead(booksKey(first.id));
        if (stored) window.storage.snapshot(booksKey(first.id), stored);
        setBooks(stored ?? []);
      } catch(e) { setSaveErr("Storage error: "+e.message); setBooks([]); }
      setReady(true);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync so save() always uses the current profile
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);

  const save = useCallback(async (next) => {
    setSaving(true);
    try { await wsWrite(booksKey(activeProfileRef.current), next); setSaveErr(null); }
    catch(e) { setSaveErr("Save failed: "+e.message); }
    setSaving(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const switchProfile = async (profileId) => {
    setReady(false);
    setBooks([]);
    setFilter("all");
    setSearch("");
    activeProfileRef.current = profileId;
    setActiveProfile(profileId);
    try {
      const stored = await wsRead(booksKey(profileId));
      if (stored) window.storage.snapshot(booksKey(profileId), stored);
      setBooks(stored ?? []);
    } catch(e) { setSaveErr("Storage error: "+e.message); setBooks([]); }
    setReady(true);
  };

  const addProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    const base = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const existingIds = new Set(profiles.map(p => p.id));
    let id = base;
    let n = 2;
    while (existingIds.has(id)) { id = `${base}-${n++}`; }
    const next = [...profiles, { id, name }];
    setProfiles(next);
    await wsWrite(PROFILES_KEY, next).catch(() => {});
    setAddingProfile(false);
    setNewProfileName("");
    switchProfile(id);
  };

  const updateAgeGroup = async (ageGroup) => {
    const next = profiles.map(p => p.id === activeProfile ? { ...p, ageGroup } : p);
    setProfiles(next);
    await wsWrite(PROFILES_KEY, next).catch(() => {});
  };

  const rejectedKey = (profileId) => `${profileId}-rejected`;

  const addToRejected = async (title) => {
    const key = rejectedKey(activeProfileRef.current);
    const current = await wsRead(key) ?? [];
    if (!current.includes(title)) {
      await wsWrite(key, [...current, title]).catch(() => {});
    }
  };

  const deleteLibrary = async () => {
    if (activeProfile === "em") return;
    const next = profiles.filter(p => p.id !== activeProfile);
    await wsWrite(PROFILES_KEY, next).catch(() => {});
    await window.storage.set(`${activeProfile}-library`, JSON.stringify([])).catch(() => {});
    setProfiles(next);
    setSettingsOpen(false);
    switchProfile("em");
  };

  useEffect(() => {
    const name = profiles.find(p => p.id === activeProfile)?.name;
    if (name) document.title = `${name}'s Audiobook Library`;
  }, [activeProfile, profiles]);

  const autoRecommendedProfiles = useRef(new Set());

  useEffect(() => {
    if (!ready || !activeProfile || autoRecommendedProfiles.current.has(activeProfile)) return;
    autoRecommendedProfiles.current.add(activeProfile);

    const needed = 2 - books.filter(b => b.status === "recommended").length;
    if (needed <= 0) return;

    const profileName = profiles.find(p => p.id === activeProfile)?.name ?? activeProfile;
    const profileAgeGroup = profiles.find(p => p.id === activeProfile)?.ageGroup ?? "adult";

    const fetchOne = async (currentBooks, rejected = []) => {
      const lovedAuthors = [...new Set(currentBooks.filter(b=>b.loved||b.rating>=5).map(b=>b.author).filter(Boolean))];
      const authorsClause = lovedAuthors.length
        ? `similar to books by these loved authors: ${lovedAuthors.join(", ")}`
        : "that is highly rated and popular";
      const alreadyHave = [...currentBooks.map(b=>b.title), ...rejected].join(", ");
      const query = `Find me an audiobook ${authorsClause}. Already in my library — do not suggest these: ${alreadyHave||"none"}. Return one well-known match.`;
      try {
        const exclude = new Set([...currentBooks.map(b=>b.title.toLowerCase()), ...rejected.map(t=>t.toLowerCase())]);
        const result = await fetchRecommendations({ books: currentBooks, profileName, ageGroup: profileAgeGroup, query, maxTokens: 2000 });
        return result.recommendations.find(r => !exclude.has(r.title.toLowerCase())) || null;
      } catch { return null; }
    };

    const profileIdAtStart = activeProfile;
    (async () => {
      const rejected = await wsRead(rejectedKey(profileIdAtStart)) ?? [];
      let currentBooks = [...books];
      for (let i = 0; i < needed; i++) {
        if (activeProfileRef.current !== profileIdAtStart) break;
        setStatusMsg({ text: `Finding a recommended book for your library${needed > 1 ? ` (${i + 1} of ${needed})` : ""}…`, isError: false });
        const rec = await fetchOne(currentBooks, rejected);
        if (!rec) continue;
        const newBook = {
          id: `rec-${rec.title.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"")}-${Date.now()}`,
          title: rec.title,
          author: rec.author,
          genre: rec.genre || "Science Fiction",
          subgenre: rec.subgenre || "",
          status: "recommended",
          rating: 0,
        };
        currentBooks = [...currentBooks, newBook];
        if (activeProfileRef.current === profileIdAtStart) {
          setStatusMsg({ text: `Added "${newBook.title}" to your library as a recommendation`, isError: false });
          setBooks([...currentBooks]);
          await wsWrite(booksKey(profileIdAtStart), currentBooks).catch(() => {});
        }
      }
      if (activeProfileRef.current === profileIdAtStart) setStatusMsg(null);
    })();
  }, [ready, activeProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBook = (form) => {
    const { targetSeriesId, ...rest } = form;
    if (!modal.book && targetSeriesId) {
      const subBook = { ...rest, series: false, id: `book-${Date.now()}` };
      const next = books.map(b => b.id === targetSeriesId ? { ...b, books: [...(b.books||[]), subBook] } : b);
      setBooks(next); save(next); setModal(null);
    } else {
      const cleaned = rest.series ? { ...rest, rating: 0 } : rest;
      const next = modal.book
        ? books.map(b => b.id === modal.book.id ? { ...b, ...cleaned } : b)
        : [...books, { ...cleaned, id: `book-${Date.now()}` }];
      setBooks(next); save(next); setModal(null);
    }
  };

  const del = (id) => {
    const book = books.find(b => b.id === id);
    const next = books.filter(b => b.id !== id);
    setBooks(next); save(next);
    if (book?.status === "recommended") addToRejected(book.title);
  };

  const genres = useMemo(() => ["all",...new Set(books.map(b=>b.genre).filter(Boolean))].sort((a,b)=>a==="all"?-1:a.localeCompare(b)), [books]);

  const shown = useMemo(() => {
    const statusOrder = { recommended:0, wanttoread:1, reading:2, read:3 };
    const filtered = books.filter(b => {
      if (filter==="loved" && !b.loved) return false;
      if (filter==="read" && getStatus(b)!=="read") return false;
      if (filter==="reading" && getStatus(b)!=="reading") return false;
      if (filter==="want" && getStatus(b)!=="wanttoread") return false;
      if (filter==="recommended" && getStatus(b)!=="recommended") return false;
      if (genre!=="all" && b.genre!==genre) return false;
      if (minRating>0 && calcSeriesRating(b)<minRating) return false;
      if (search) { const q=search.toLowerCase(); const subMatch=b.books?.some(sb=>sb.title?.toLowerCase().includes(q)); if (!b.title?.toLowerCase().includes(q)&&!b.author?.toLowerCase().includes(q)&&!subMatch) return false; }
      return true;
    });
    // For READING and WANT filters, also surface individual books within series that match
    const extra = [];
    if (filter==="reading" || filter==="want") {
      const targetStatus = filter==="reading" ? "reading" : "wanttoread";
      const shownIds = new Set(filtered.map(b=>b.id));
      books.forEach(series => {
        if (!series.series || !series.books) return;
        series.books.forEach(sb => {
          if (sb.status!==targetStatus) return;
          if (shownIds.has(sb.id)) return;
          if (genre!=="all" && sb.genre!==genre) return;
          if (minRating>0 && (sb.rating||0)<minRating) return;
          if (search) { const q=search.toLowerCase(); if (!sb.title?.toLowerCase().includes(q)&&!sb.author?.toLowerCase().includes(q)) return; }
          extra.push({ ...sb, _parentSeries: series });
        });
      });
    }
    return [...filtered, ...extra].sort((a,b) => {
      const sa = statusOrder[getStatus(a)]??2, sb = statusOrder[getStatus(b)]??2;
      const ra = calcSeriesRating(a), rb = calcSeriesRating(b);
      switch(sortBy) {
        case "rating": if(sa!==sb) return sa-sb; return rb-ra;
        case "title": return (a.title||"").localeCompare(b.title||"");
        case "author": return (a.author||"").localeCompare(b.author||"");
        case "genre": return (a.genre||"").localeCompare(b.genre||"");
        case "status": if(sa!==sb) return sa-sb; return rb-ra;
        case "loved": { const la=b.loved?1:0,lb=a.loved?1:0; if(la!==lb) return la-lb; return rb-ra; }
        case "lovedauthor": { const la=isSpecial(b.author)?1:0,lb=isSpecial(a.author)?1:0; if(la!==lb) return la-lb; return rb-ra; }
        default: return 0;
      }
    });
  }, [books,filter,genre,search,minRating,sortBy]);

  const stats = useMemo(() => {
    const read = books.filter(b=>getStatus(b)==="read");
    return { read:read.length, loved:read.filter(b=>b.loved).length, reading:books.filter(b=>getStatus(b)==="reading").length, want:books.filter(b=>getStatus(b)==="wanttoread").length, rec:books.filter(b=>getStatus(b)==="recommended").length, avg:read.length?(read.reduce((s,b)=>s+calcSeriesRating(b),0)/read.length).toFixed(1):"—" };
  }, [books]);

  const exportData = () => {
    const json = JSON.stringify(books, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${activeProfile}-library.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const importData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!Array.isArray(parsed)) return alert("Invalid file format.");
        setBooks(parsed); save(parsed);
      } catch { alert("Could not parse file."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const tb = (t,l) => <button onClick={()=>setTab(t)} style={{ padding:"5px 12px", borderRadius:4, fontSize:18, fontWeight:700, letterSpacing:"0.08em", fontFamily:"monospace", cursor:"pointer", border:"1px solid", background:tab===t?"var(--surface-mid)":"transparent", color:tab===t?"var(--text)":"var(--text-dim)", borderColor:tab===t?"var(--text-dim)":"transparent" }}>{l}</button>;
  const fb = (f,l) => <button onClick={()=>setFilter(f)} style={{ padding:"3px 9px", borderRadius:3, fontSize:16, fontWeight:700, letterSpacing:"0.06em", fontFamily:"monospace", cursor:"pointer", border:"1px solid", background:filter===f?"var(--surface-mid)":"transparent", color:filter===f?"var(--text)":"var(--text-dim)", borderColor:filter===f?"var(--text-dim)":"transparent" }}>{l}</button>;
  const sel = { padding:"5px 9px", borderRadius:4, background:"var(--surface)", border:"1px solid var(--surface-mid)", color:"var(--text)", fontSize:18, fontFamily:"monospace", outline:"none" };

  if (!ready) return <div style={{ background:"var(--bg)", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center" }}><span style={{ color:"var(--text-dim)", fontFamily:"monospace", fontSize:19 }}>Loading...</span></div>;

  return (
    <div style={{ background:"var(--bg)", minHeight:"100vh", color:"var(--text)", fontFamily:"'Georgia',serif", padding:"24px 22px", maxWidth: isWide ? 1320 : 960, margin:"0 auto" }}>
      <div style={{ marginBottom:18 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10, gap:12 }}>
          <div>
            <h1 style={{ margin:0, fontSize:32, fontWeight:700, fontFamily:"'Georgia',serif", background:"linear-gradient(135deg,var(--text),var(--text-muted))", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", letterSpacing:"-0.02em" }}>
              {profiles.find(p=>p.id===activeProfile)?.name ?? "…"}'s Audiobook Library
            </h1>
            <div style={{ display:"flex", gap:4, marginTop:6, alignItems:"center", flexWrap:"wrap" }}>
              {profiles.map(p => (
                <button key={p.id} onClick={()=>p.id!==activeProfile&&switchProfile(p.id)}
                  style={{ padding:"2px 10px", borderRadius:3, fontSize:16, fontWeight:700, letterSpacing:"0.06em", fontFamily:"monospace", cursor:p.id===activeProfile?"default":"pointer", border:"1px solid", background:p.id===activeProfile?"var(--surface-mid)":"transparent", color:p.id===activeProfile?"var(--text)":"var(--text-dim)", borderColor:p.id===activeProfile?"var(--text-dim)":"transparent" }}>
                  {p.name}
                </button>
              ))}
              {addingProfile
                ? <span style={{ display:"flex", gap:4 }}>
                    <input autoFocus value={newProfileName} onChange={e=>setNewProfileName(e.target.value)}
                      onKeyDown={e=>{ if(e.key==="Enter") addProfile(); if(e.key==="Escape"){ setAddingProfile(false); setNewProfileName(""); } }}
                      placeholder="Name…"
                      style={{ padding:"2px 8px", borderRadius:3, background:"var(--surface)", border:"1px solid var(--text-dim)", color:"var(--text)", fontSize:16, fontFamily:"monospace", outline:"none", width:90 }}/>
                    <button onClick={addProfile} style={{ padding:"2px 8px", borderRadius:3, border:"none", background:"#f59e0b", color:"var(--accent-fg)", fontSize:16, fontFamily:"monospace", fontWeight:700, cursor:"pointer" }}>ADD</button>
                    <button onClick={()=>{ setAddingProfile(false); setNewProfileName(""); }} style={{ padding:"2px 6px", borderRadius:3, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:16, fontFamily:"monospace", cursor:"pointer" }}>✕</button>
                  </span>
                : <button onClick={()=>setAddingProfile(true)} style={{ padding:"2px 8px", borderRadius:3, border:"1px dashed var(--border)", background:"transparent", color:"var(--text-dim)", fontSize:16, fontFamily:"monospace", cursor:"pointer" }}>+ new</button>
              }
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
            {saving && <span style={{ fontSize:14, color:"var(--text-muted)", fontFamily:"monospace" }}>saving...</span>}
            {saveErr && <span style={{ fontSize:14, color:"var(--danger)", fontFamily:"monospace" }}>{saveErr}</span>}
            {!isNarrow && <button onClick={exportData} style={{ padding:"5px 10px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontWeight:700, fontSize:18, fontFamily:"monospace", cursor:"pointer", letterSpacing:"0.05em" }}>↓ EXPORT</button>}
            {!isNarrow && <label style={{ padding:"5px 10px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontWeight:700, fontSize:18, fontFamily:"monospace", cursor:"pointer", letterSpacing:"0.05em" }}>
              ↑ IMPORT<input type="file" accept=".json" onChange={importData} style={{ display:"none" }}/>
            </label>}
            <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} style={{ padding:"5px 10px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:18, fontFamily:"monospace", fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", letterSpacing:"0.05em" }}>
              {theme === "dark"
                ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              }
            </button>
            <button onClick={onLock} title="Lock" style={{ padding:"5px 10px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, fontSize:18, fontFamily:"monospace", fontWeight:700, letterSpacing:"0.05em" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              LOCK
            </button>
            <button onClick={()=>setSettingsOpen(true)} title="Settings" style={{ padding:"5px 10px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:18, fontFamily:"monospace", fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>⚙</button>
          </div>
        </div>
        <div style={{ display:"flex", gap:16, flexWrap:"wrap", alignItems:"flex-start" }}>
          {[["READ",stats.read],["LOVED",stats.loved],["READING",stats.reading],["WANT",stats.want],["REC",stats.rec],["AVG",`${stats.avg}★`]].map(([l,v])=>(
            <div key={l} style={{ textAlign:"center" }}>
              <div style={{ fontSize:24, fontWeight:700, color:"var(--text)", fontFamily:"monospace", lineHeight:1 }}>{v}</div>
              <div style={{ fontSize:14, color:"var(--text-dim)", fontFamily:"monospace", letterSpacing:"0.1em" }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {statusMsg && (
        <div style={{ marginBottom:12, padding:"7px 12px", borderRadius:4, fontFamily:"monospace", fontSize:16, border:`1px solid ${statusMsg.isError?"var(--danger-bg)":"#166534"}`, background:statusMsg.isError?"var(--status-err-bg)":"var(--status-ok-bg)", color:statusMsg.isError?"var(--danger)":"#4ade80" }}>
          {statusMsg.text}
        </div>
      )}
      <div style={{ display:"flex", gap:4, marginBottom:14, borderBottom:"1px solid var(--border-subtle)", paddingBottom:10, alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", gap:4 }}>{tb("library","LIBRARY")}{tb("recommend","RECOMMEND")}</div>
        <button onClick={()=>setModal({book:null})} style={{ padding:"5px 12px", borderRadius:4, border:"none", background:"#f59e0b", color:"var(--accent-fg)", fontWeight:700, fontSize:18, fontFamily:"monospace", cursor:"pointer", letterSpacing:"0.05em" }}>+ ADD</button>
      </div>

      {tab==="library" && <>
        <div style={{ display:"flex", gap:3, flexWrap:"wrap", marginBottom:8 }}>
          {fb("all","ALL")}{fb("recommended","★ REC")}{fb("loved","★ LOVED")}{fb("read","READ")}{fb("reading","READING")}{fb("want","WANT TO READ")}
        </div>
        <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
          <div style={{ position:"relative", display:"flex", alignItems:"center" }}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..." style={{ padding:"5px 28px 5px 9px", borderRadius:4, background:"var(--surface)", border:"1px solid var(--surface-mid)", color:"var(--text)", fontSize:18, fontFamily:"monospace", outline:"none", width:280 }}/>
            {search && <button onClick={()=>setSearch("")} style={{ position:"absolute", right:6, background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", fontSize:21, lineHeight:1, padding:0 }}>×</button>}
          </div>
          <select value={genre} onChange={e=>setGenre(e.target.value)} style={sel}>{genres.map(g=><option key={g} value={g}>{g==="all"?"All Genres":g}</option>)}</select>
          <select value={minRating} onChange={e=>setMinRating(Number(e.target.value))} style={sel}>
            <option value={0}>Any Rating</option><option value={5}>5★+</option><option value={4}>4★+</option><option value={3}>3★+</option>
          </select>
          <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={sel}>
            <option value="rating">Sort: Rating</option>
            <option value="title">Sort: Title A–Z</option>
            <option value="author">Sort: Author A–Z</option>
            <option value="genre">Sort: Genre A–Z</option>
            <option value="status">Sort: Status</option>
            <option value="loved">Sort: Loved Book</option>
            <option value="lovedauthor">Sort: Loved Author</option>
          </select>
        </div>
        <div style={{ fontSize:16, color:"var(--text-dim)", fontFamily:"monospace", marginBottom:10 }}>{shown.length} of {books.length} — gold corner = loved · purple = loved author</div>
        <div style={{ display:"grid", gridTemplateColumns: isWide ? "repeat(3,1fr)" : "repeat(auto-fill,minmax(230px,1fr))", gap: isWide ? 12 : 7 }}>
          {shown.map(b=><Card key={b.id} book={b} onEdit={()=>b._parentSeries ? setSeriesModal(b._parentSeries) : setModal({book:b})} onDelete={()=>b._parentSeries ? setSeriesModal(b._parentSeries) : del(b.id)} onView={b.series ? ()=>setSeriesModal(b) : undefined}/>)}
        </div>
      </>}

      {tab==="recommend" && <Recommend books={books} profileName={profiles.find(p=>p.id===activeProfile)?.name??activeProfile} ageGroup={profiles.find(p=>p.id===activeProfile)?.ageGroup??"adult"} onStatusChange={setStatusMsg} onAdd={(book)=>{ const next=[...books,book]; setBooks(next); save(next); }}/>}

      {settingsOpen && <SettingsModal activeProfile={activeProfile} activeProfileName={profiles.find(p=>p.id===activeProfile)?.name??""} ageGroup={profiles.find(p=>p.id===activeProfile)?.ageGroup??"adult"} onAgeGroupChange={updateAgeGroup} onDeleteLibrary={deleteLibrary} onClose={()=>setSettingsOpen(false)}/>}
      {modal && <Modal book={modal.book} onSave={saveBook} onClose={()=>setModal(null)} seriesList={books.filter(b=>b.series)} isSub={false} profileName={profiles.find(p=>p.id===activeProfile)?.name??activeProfile}/>}
      {seriesModal && <SeriesModal
        series={seriesModal}
        onClose={()=>setSeriesModal(null)}
        onUpdate={(updated)=>{ const next=books.map(b=>b.id===updated.id?updated:b); setBooks(next); save(next); setSeriesModal(updated); }}
        onDeleteBook={(bookId)=>{ const updated={...seriesModal,books:(seriesModal.books||[]).filter(b=>b.id!==bookId)}; const next=books.map(b=>b.id===updated.id?updated:b); setBooks(next); save(next); setSeriesModal(updated); }}
        profileName={profiles.find(p=>p.id===activeProfile)?.name??activeProfile}
      />}
    </div>
  );
}
