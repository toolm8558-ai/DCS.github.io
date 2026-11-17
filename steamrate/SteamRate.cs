// SteamRate: works out plant performance tags from other tags and saves them in MongoDB the same way
// TrendToMongo saves every other tag, so the DCS Trends site shows their live values and trends.
//
//   STEAM_RATE.PV  FT_02A.PV / TG_LOAD.PV                                       TPH/MW
//   H_MS.PV        main steam enthalpy from PT_02.PV and TT_07A.PV, IAPWS-IF97   kJ/kg
//   SR_CORR.PV     steam rate corrected to h 3440 kJ/kg and 19.5 MW (plant fit)  TPH/MW
//
//   live_latest   every second, from the newest live readings (newest 2 values kept)
//   trend_minute  one document per minute whose inputs are all recorded, including all older history
//   tag_info      description, unit and range, so search and the trend page know each tag
//
// It only inserts documents for these tags and updates their own live entries. It never deletes
// anything and never touches another tag. A minute already saved is never written again.
// Run with --once to fill the history and stop; without it, it keeps running.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using MongoDB.Bson;
using MongoDB.Driver;

// IAPWS-IF97 Region 2 (superheated steam) and Region 4 (boiling point). Checked against the IF97
// test values and steam tables for superheated steam up to 10 MPa.
static class IF97 {
    const double R = 0.461526;
    static readonly int[] J0 = { 0, 1, -5, -4, -3, -2, -1, 2, 3 };
    static readonly double[] N0 = { -0.96927686500217e1, 0.10086655968018e2, -0.56087911283020e-2, 0.71452738081455e-1, -0.40710498223928, 0.14240819171444e1, -0.43839511319450e1, -0.28408632460772, 0.21268463753307e-1 };
    static readonly int[] I = { 1,1,1,1,1,2,2,2,2,2,3,3,3,3,3,4,4,4,5,6,6,6,7,7,7,8,8,9,10,10,10,16,16,18,20,20,20,21,22,23,24,24,24 };
    static readonly int[] J = { 0,1,2,3,6,1,2,4,7,36,0,1,3,6,35,1,2,3,7,3,16,35,0,11,25,8,36,13,4,10,14,29,50,57,20,35,48,21,53,39,26,40,58 };
    static readonly double[] N = {
        -0.17731742473213e-2, -0.17834862292358e-1, -0.45996013696365e-1, -0.57581259083432e-1, -0.50325278727930e-1,
        -0.33032641670203e-4, -0.18948987516315e-3, -0.39392777243355e-2, -0.43797295650573e-1, -0.26674547914087e-4,
        0.20481737692309e-7, 0.43870667284435e-6, -0.32277677238570e-4, -0.15033924542148e-2, -0.40668253562649e-1,
        -0.78847309559367e-9, 0.12790717852285e-7, 0.48225372718507e-6, 0.22922076337661e-5, -0.16714766451061e-10,
        -0.21171472321355e-2, -0.23895741934104e2, -0.59059564324270e-17, -0.12621808899101e-5, -0.38946842435739e-1,
        0.11256211360459e-10, -0.82311340897998e1, 0.19809712802088e-7, 0.10406965210174e-18, -0.10234747095929e-12,
        -0.10018179379511e-8, -0.80882908646985e-10, 0.10693031879409, -0.33662250574171, 0.89185845355421e-24,
        0.30629316876232e-12, -0.42002467698208e-5, -0.59056029685639e-21, 0.37826947613457e-5, -0.12768608934681e-14,
        0.73087610595061e-28, 0.55414715350778e-16, -0.94369707241210e-5 };

    // p in MPa absolute, T in kelvin; h in kJ/kg.
    public static double H(double p, double t) {
        double tau = 540.0 / t, g0 = 0, gr = 0;
        for (int i = 0; i < 9; i++) g0 += N0[i] * J0[i] * Math.Pow(tau, J0[i] - 1);
        for (int i = 0; i < 43; i++) gr += N[i] * Math.Pow(p, I[i]) * J[i] * Math.Pow(tau - 0.5, J[i] - 1);
        return R * t * tau * (g0 + gr);
    }

    public static double Tsat(double p) {
        double[] n = { 0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.12020824702470e5, -0.32325550322333e7, 0.14915108613530e2, -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849, 0.65017534844798e3 };
        double b = Math.Pow(p, 0.25), E = b * b + n[2] * b + n[5], F = n[0] * b * b + n[3] * b + n[6], G = n[1] * b * b + n[4] * b + n[7];
        double D = 2 * G / (-F - Math.Sqrt(F * F - 4 * E * G));
        return (n[9] + D - Math.Sqrt((n[9] + D) * (n[9] + D) - 4 * (n[8] + n[9] * D))) / 2;
    }

    // Region 2 specific entropy, kJ/(kg K).
    public static double S(double p, double t) {
        double tau = 540.0 / t, g0 = Math.Log(p), g0t = 0, gr = 0, grt = 0;
        for (int i = 0; i < 9; i++) { g0 += N0[i] * Math.Pow(tau, J0[i]); g0t += N0[i] * J0[i] * Math.Pow(tau, J0[i] - 1); }
        for (int i = 0; i < 43; i++) { gr += N[i] * Math.Pow(p, I[i]) * Math.Pow(tau - 0.5, J[i]); grt += N[i] * Math.Pow(p, I[i]) * J[i] * Math.Pow(tau - 0.5, J[i] - 1); }
        return R * (tau * (g0t + grt) - (g0 + gr));
    }

    public static double Mpa(double gaugeKgf) { return (gaugeKgf + 1.0332) * 0.0980665; }

    // Main steam enthalpy from a plant reading (gauge kgf/cm2, C). Null outside the checked range:
    // above 10 MPa, or less than 15 C of superheat (for example while the boiler is starting).
    public static double? FromPlant(double gaugeKgf, double tempC) {
        if (double.IsNaN(gaugeKgf) || double.IsNaN(tempC)) return null;
        double p = Mpa(gaugeKgf), t = tempC + 273.15;
        if (p <= 0.05 || p > 10 || t - Tsat(p) < 15) return null;
        return H(p, t);
    }

    // Enthalpy at pressure p (MPa) after an ideal expansion with entropy s1. Superheated: the temperature
    // with that entropy. Wet: dryness from the saturated liquid and vapour. Saturated liquid uses
    // h ~ 4.18 t and s ~ 4.18 ln(T/273.15), within about 2 kJ/kg below about 150 C.
    public static double? IsentropicH(double p, double s1) {
        if (p <= 0.001 || p > 10) return null;
        double ts = Tsat(p), sg = S(p, ts);
        if (s1 >= sg) {
            double lo = ts, hi = 1073.15;
            for (int k = 0; k < 60; k++) { double m = (lo + hi) / 2; if (S(p, m) > s1) hi = m; else lo = m; }
            return H(p, lo);
        }
        if (ts > 423.15) return null;   // the liquid estimate below is only good up to about 150 C
        double hf = 4.18 * (ts - 273.15), sf = 4.18 * Math.Log(ts / 273.15), x = (s1 - sf) / (sg - sf);
        if (x < 0.5) return null;
        return hf + x * (H(p, ts) - hf);
    }

    // Ideal (isentropic) enthalpy drop from main steam to a lower pressure, kJ/kg.
    public static double? IdealDrop(double inGauge, double inTempC, double outGauge) {
        var h1 = FromPlant(inGauge, inTempC);
        if (h1 == null || double.IsNaN(outGauge)) return null;
        double p1 = Mpa(inGauge), p2 = Mpa(outGauge);
        if (p2 >= p1) return null;
        var h2s = IsentropicH(p2, S(p1, inTempC + 273.15));
        return h2s == null ? null : h1 - h2s;
    }

    // Isentropic efficiency (%) from main steam to a point where the steam is still superheated.
    public static double? SectionEfficiency(double inGauge, double inTempC, double outGauge, double outTempC) {
        var h1 = FromPlant(inGauge, inTempC);
        if (h1 == null || double.IsNaN(outGauge) || double.IsNaN(outTempC)) return null;
        double p2 = Mpa(outGauge), t2 = outTempC + 273.15;
        if (p2 <= 0.01 || p2 >= Mpa(inGauge) || t2 <= Tsat(p2) + 1) return null;
        var h2s = IsentropicH(p2, S(Mpa(inGauge), inTempC + 273.15));
        if (h2s == null || h1.Value - h2s.Value <= 0) return null;
        double eff = (h1.Value - H(p2, t2)) / (h1.Value - h2s.Value) * 100;
        return eff > 0 && eff < 110 ? eff : (double?)null;
    }
}

// A tag worked out from other tags.
class Derived {
    public string Tag, Unit, Description;
    public double Lo, Hi;
    public string[] Inputs;
    public Func<Dictionary<string, double>, double?> Calc;
}

static class SteamRate {
    const string Flow = "FT_02A.PV", Load = "TG_LOAD.PV", Press = "PT_02.PV", Temp = "TT_07A.PV";
    const string Exhaust = "PT_106_1.PV", Ext1P = "PT_103_1.PV", Ext1T = "TE103.PV";
    // Below 1 MW the turbine is not really on load and the ratio means nothing (it runs to thousands).
    const double MinLoadMW = 1.0;
    // Plant fit (11-16 Nov 2026, load >= 10 MW): SR = 12.702 - 0.0019 h - 0.0221 load. Only used in that load range.
    const double FitH = 0.0019, FitLoad = 0.0221, RefH = 3440, RefLoad = 19.5, FitMinLoad = 10;
    const int Batch = 5000, ChunkDays = 7, RecheckDays = 2;
    static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    static readonly object LogGate = new object();
    static string home, libDir, logDir;
    static IMongoDatabase db;

    static double? Rate(double flow, double load) {
        if (double.IsNaN(flow) || double.IsNaN(load) || double.IsInfinity(flow) || double.IsInfinity(load)) return null;
        if (load < MinLoadMW || flow < 0) return null;
        return flow / load;
    }

    static readonly Derived[] Tags = {
        new Derived { Tag = "STEAM_RATE.PV", Unit = "TPH/MW", Description = "Steam rate (Main steam flow-A / TG load)", Lo = 0, Hi = 10,
            Inputs = new[] { Flow, Load }, Calc = v => Rate(v[Flow], v[Load]) },
        new Derived { Tag = "H_MS.PV", Unit = "kJ/kg", Description = "Main steam enthalpy (PT_02, TT_07A, IAPWS-IF97)", Lo = 3000, Hi = 3600,
            Inputs = new[] { Press, Temp }, Calc = v => IF97.FromPlant(v[Press], v[Temp]) },
        new Derived { Tag = "SR_CORR.PV", Unit = "TPH/MW", Description = "Corrected steam rate (to 3440 kJ/kg and 19.5 MW)", Lo = 0, Hi = 10,
            Inputs = new[] { Flow, Load, Press, Temp }, Calc = v => {
                if (v[Load] < FitMinLoad) return null;
                var sr = Rate(v[Flow], v[Load]); var h = IF97.FromPlant(v[Press], v[Temp]);
                if (sr == null || h == null) return null;
                return sr.Value + FitH * (h.Value - RefH) + FitLoad * (v[Load] - RefLoad);
            } },
        // Steam rate depends on the enthalpy DROP, not on the inlet enthalpy alone: lower inlet pressure or
        // temperature and higher exhaust back-pressure both shrink it. These three record that drop.
        new Derived { Tag = "DH_IS.PV", Unit = "kJ/kg", Description = "Ideal enthalpy drop, main steam to exhaust (PT_02, TT_07A, PT_106_1)", Lo = 0, Hi = 1500,
            Inputs = new[] { Press, Temp, Exhaust }, Calc = v => IF97.IdealDrop(v[Press], v[Temp], v[Exhaust]) },
        new Derived { Tag = "SR_IDEAL.PV", Unit = "TPH/MW", Description = "Ideal steam rate 3600 / ideal enthalpy drop (no losses, no extraction)", Lo = 0, Hi = 10,
            Inputs = new[] { Press, Temp, Exhaust }, Calc = v => { var dh = IF97.IdealDrop(v[Press], v[Temp], v[Exhaust]); return dh > 100 ? (double?)(3600 / dh.Value) : null; } },
        new Derived { Tag = "HP_EFF.PV", Unit = "%", Description = "HP section isentropic efficiency, main steam to 1st extraction", Lo = 0, Hi = 100,
            Inputs = new[] { Press, Temp, Ext1P, Ext1T }, Calc = v => IF97.SectionEfficiency(v[Press], v[Temp], v[Ext1P], v[Ext1T]) }
    };

    static Assembly FindInLib(object sender, ResolveEventArgs e) {
        var path = Path.Combine(libDir, new AssemblyName(e.Name).Name + ".dll");
        return File.Exists(path) ? Assembly.LoadFrom(path) : null;
    }

    // config.ini and lib\ are taken from this folder, or else from a TrendToMongo folder beside it.
    static string Locate(string name) {
        var here = Path.Combine(home, name);
        if (File.Exists(here) || Directory.Exists(here)) return here;
        var beside = Path.Combine(Path.Combine(Path.GetDirectoryName(home), "TrendToMongo"), name);
        if (File.Exists(beside) || Directory.Exists(beside)) return beside;
        throw new FileNotFoundException(name + " was not found in " + home + " or a TrendToMongo folder beside it");
    }

    [MTAThread]
    static int Main(string[] args) {
        home = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        logDir = Path.Combine(home, "logs");
        Directory.CreateDirectory(logDir);
        libDir = Locate("lib");
        AppDomain.CurrentDomain.AssemblyResolve += FindInLib;
        bool once = args.Contains("--once");
        bool first;
        using (var single = new Mutex(true, @"Global\SteamRate", out first)) {
            if (!first) { Log("Already running, exiting."); return 0; }
            Run(once);
        }
        return 0;
    }

    static void Log(string text) {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text;
        lock (LogGate) {
            Console.WriteLine(line);
            try { File.AppendAllText(Path.Combine(logDir, "SteamRate_" + DateTime.Now.ToString("yyyyMMdd") + ".log"), line + "\r\n"); } catch (IOException) { }
        }
    }

    static void Connect() {
        string uri = null, name = "plant_trend";
        foreach (var raw in File.ReadAllLines(Locate("config.ini"))) {
            var line = raw.Trim();
            int eq = line.IndexOf('=');
            if (line.Length == 0 || line[0] == ';' || eq < 0) continue;
            string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
            if (key == "MongoUri") uri = value;
            if (key == "Database") name = value;
        }
        if (string.IsNullOrEmpty(uri)) throw new Exception("config.ini has no MongoUri");
        var settings = MongoClientSettings.FromConnectionString(uri);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(30);
        db = new MongoClient(settings).GetDatabase(name);
        db.RunCommand<BsonDocument>(new BsonDocument("ping", 1));
    }

    static void Run(bool once) {
        Log("Started" + (once ? " (fill history once)" : "") + ": " + string.Join(", ", Tags.Select(d => d.Tag)));
        while (true) {
            try { Connect(); break; }
            catch (Exception e) { Log("Cannot reach MongoDB, retrying in 30 seconds: " + First(e)); if (once) return; Thread.Sleep(30000); }
        }
        SaveTagInfo();
        var oldest = Edge(true);
        if (oldest == null) Log("No " + Load + " history yet.");
        else Log("History filled from " + oldest.Value.ToString("yyyy-MM-dd") + ": " + FillHistory(oldest.Value));
        if (once) return;

        new Thread(KeepHistory) { IsBackground = true }.Start();
        RunLive();
    }

    static string First(Exception e) { return e.GetType().Name + ": " + e.Message.Split('\n')[0]; }

    static IMongoCollection<BsonDocument> C(string name) { return db.GetCollection<BsonDocument>(name); }
    static FilterDefinitionBuilder<BsonDocument> F { get { return Builders<BsonDocument>.Filter; } }

    static void SaveTagInfo() {
        foreach (var d in Tags) {
            var doc = new BsonDocument { { "_id", d.Tag }, { "description", d.Description }, { "unit", d.Unit }, { "type", "FLOAT" }, { "lo", d.Lo }, { "hi", d.Hi } };
            C("tag_info").ReplaceOne(F.Eq("_id", d.Tag), doc, new ReplaceOptions { IsUpsert = true });
        }
    }

    // Times come from the database, never from this computer's clock, which may be set wrong.
    static DateTime? Edge(bool oldest) {
        var sort = oldest ? Builders<BsonDocument>.Sort.Ascending("t") : Builders<BsonDocument>.Sort.Descending("t");
        var d = C("trend_minute").Find(F.Eq("tag", Load)).Sort(sort).Limit(1).FirstOrDefault();
        return d == null ? (DateTime?)null : d["t"].ToUniversalTime();
    }

    static Dictionary<DateTime, double> Minutes(string tag, DateTime from, DateTime to) {
        var found = new Dictionary<DateTime, double>();
        var range = F.Eq("tag", tag) & F.Gte("t", from) & F.Lt("t", to);
        var only = Builders<BsonDocument>.Projection.Include("t").Include("v").Exclude("_id");
        foreach (var d in C("trend_minute").Find(range).Project(only).ToEnumerable()) {
            BsonValue v;
            if (d.TryGetValue("v", out v) && v.IsNumeric) found[d["t"].ToUniversalTime()] = v.ToDouble();
        }
        return found;
    }

    // Saves every derived tag for each minute from 'from' to the newest history that has all its inputs
    // and is not saved yet. Returns a short "TAG +n" summary.
    static string FillHistory(DateTime from) {
        var minute = C("trend_minute");
        var newest = Edge(false);
        if (newest == null) return "nothing to do";
        var end = newest.Value.AddMinutes(1);
        var added = Tags.ToDictionary(d => d.Tag, d => 0L);
        var inputs = Tags.SelectMany(d => d.Inputs).Distinct().ToArray();
        for (var start = from; start < end; start = start.AddDays(ChunkDays)) {
            var stop = start.AddDays(ChunkDays) < end ? start.AddDays(ChunkDays) : end;
            var data = inputs.ToDictionary(t => t, t => Minutes(t, start, stop));
            var docs = new List<BsonDocument>(Batch);
            foreach (var d in Tags) {
                var saved = new HashSet<DateTime>(Minutes(d.Tag, start, stop).Keys);
                foreach (var t in data[d.Inputs[0]].Keys.OrderBy(k => k)) {
                    if (saved.Contains(t) || d.Inputs.Any(i => !data[i].ContainsKey(t))) continue;
                    var value = d.Calc(d.Inputs.ToDictionary(i => i, i => data[i][t]));
                    if (value == null || double.IsNaN(value.Value) || double.IsInfinity(value.Value)) continue;
                    docs.Add(new BsonDocument { { "t", t }, { "tag", d.Tag }, { "v", Math.Round(value.Value, 4) } });
                    added[d.Tag]++;
                    if (docs.Count >= Batch) { minute.InsertMany(docs, new InsertManyOptions { IsOrdered = false }); docs.Clear(); }
                }
            }
            if (docs.Count > 0) minute.InsertMany(docs, new InsertManyOptions { IsOrdered = false });
        }
        return string.Join(", ", added.Select(p => p.Key + " +" + p.Value));
    }

    // History arrives about every 10 minutes. Each minute the last two days are checked again, which
    // also puts back any minute that was not saved while this program or the internet was down.
    static void KeepHistory() {
        while (true) {
            Thread.Sleep(60000);
            try {
                var newest = Edge(false);
                if (newest == null) continue;
                var summary = FillHistory(newest.Value.AddDays(-RecheckDays));
                if (summary.Split(',').Any(s => !s.Trim().EndsWith("+0"))) Log("History: " + summary);
            } catch (Exception e) { Log("History not saved, trying again in a minute: " + First(e)); }
        }
    }

    static bool Newest(BsonDocument doc, out DateTime t, out double v) {
        t = DateTime.MinValue; v = double.NaN;
        BsonValue values;
        if (doc == null || !doc.TryGetValue("values", out values) || !values.IsBsonArray || values.AsBsonArray.Count == 0) return false;
        var first = values.AsBsonArray[0].AsBsonDocument;
        if (!first.Contains("t") || !first.Contains("v") || !first["v"].IsNumeric) return false;
        t = first["t"].ToUniversalTime(); v = first["v"].ToDouble();
        return true;
    }

    // Every second: when all inputs of a tag have a new reading for the same second, its value is pushed
    // to the front of that tag in live_latest, keeping the newest two like the other live tags.
    static void RunLive() {
        var live = C("live_latest");
        var inputs = Tags.SelectMany(d => d.Inputs).Distinct().ToArray();
        var last = Tags.ToDictionary(d => d.Tag, d => DateTime.MinValue);
        var waiting = Tags.ToDictionary(d => d.Tag, d => false);
        var next = DateTime.UtcNow;
        bool failing = false;
        Log("Live: saving " + string.Join(", ", Tags.Select(d => d.Tag)) + " every second");
        while (true) {
            try {
                var docs = live.Find(F.In("_id", inputs)).ToList();
                var times = new Dictionary<string, DateTime>();
                var values = new Dictionary<string, double>();
                foreach (var name in inputs) {
                    DateTime t; double v;
                    if (Newest(docs.FirstOrDefault(d => d["_id"] == name), out t, out v)) { times[name] = t; values[name] = v; }
                }
                foreach (var d in Tags) {
                    if (d.Inputs.Any(i => !times.ContainsKey(i))) continue;
                    var t = times[d.Inputs[0]];
                    // A new second for every input. If live reading stops, the time stops moving and nothing is written.
                    if (d.Inputs.Any(i => times[i] != t) || t <= last[d.Tag]) continue;
                    last[d.Tag] = t;
                    var value = d.Calc(d.Inputs.ToDictionary(i => i, i => values[i]));
                    if (value != null && !double.IsNaN(value.Value) && !double.IsInfinity(value.Value)) {
                        var entry = new BsonDocument { { "time", (t + Ist).ToString("yyyy-MM-dd HH:mm:ss") }, { "v", Math.Round(value.Value, 4) }, { "t", t } };
                        var update = Builders<BsonDocument>.Update.Set("unit", d.Unit).PushEach("values", new[] { entry }, 2, 0);
                        live.UpdateOne(F.Eq("_id", d.Tag), update, new UpdateOptions { IsUpsert = true });
                        if (waiting[d.Tag]) { Log("Live: " + d.Tag + " saving again"); waiting[d.Tag] = false; }
                    } else if (!waiting[d.Tag]) { Log("Live: " + d.Tag + " has no valid value (load too low or steam not superheated), not saved until it has"); waiting[d.Tag] = true; }
                }
                if (failing) { Log("Live: saving again"); failing = false; }
            } catch (Exception e) {
                if (!failing) Log("Live not saved, retrying: " + First(e));
                failing = true;
                Thread.Sleep(10000);
                next = DateTime.UtcNow;
            }
            next = next.AddSeconds(1);
            var wait = next - DateTime.UtcNow;
            if (wait > TimeSpan.Zero) Thread.Sleep(wait); else next = DateTime.UtcNow;
        }
    }
}
