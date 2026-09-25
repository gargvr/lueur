import Foundation
import Capacitor
import HealthKit
import UserNotifications

// MARK: - Registration

/// Registers the Lueur plugin with the Capacitor bridge.
class LueurBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LueurHealthPlugin())
    }
}

// MARK: - HealthKit collection (read-only, on this device)

/// A day is keyed by the date you wake up on. Bedtime ("onset") is minutes after noon of the
/// previous day, the same convention as js/engine.js (23:30 -> 690, 01:00 -> 780).
struct LueurDay {
    var steps: Double?; var sleepMin: Double?; var onset: Double?
    var restingHR: Double?; var hrv: Double?; var daylight: Double?; var exercise: Double?; var moodHealth: Double?

    var json: [String: Any] {
        var o: [String: Any] = [:]
        if let v = steps { o["steps"] = Int(v.rounded()) }
        if let v = sleepMin { o["sleepMin"] = Int(v.rounded()) }
        if let v = onset { o["onset"] = Int(v.rounded()) }
        if let v = restingHR { o["restingHR"] = (v * 10).rounded() / 10 }
        if let v = hrv { o["hrv"] = (v * 10).rounded() / 10 }
        if let v = daylight { o["daylight"] = Int(v.rounded()) }
        if let v = exercise { o["exercise"] = Int(v.rounded()) }
        if let v = moodHealth { o["moodHealth"] = (v * 10).rounded() / 10 }
        return o
    }
}

enum LueurHealth {
    static let store = HKHealthStore()
    static var cal: Calendar { Calendar.current }

    static var readTypes: Set<HKObjectType> {
        var s: Set<HKObjectType> = [
            HKQuantityType(.stepCount),
            HKCategoryType(.sleepAnalysis),
            HKQuantityType(.restingHeartRate),
            HKQuantityType(.heartRateVariabilitySDNN),
            HKQuantityType(.appleExerciseTime),
        ]
        if #available(iOS 17.0, *) { s.insert(HKQuantityType(.timeInDaylight)) }
        if #available(iOS 18.0, *) { s.insert(HKObjectType.stateOfMindType()) }
        return s
    }

    static func dayKey(_ d: Date) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    static func onsetOf(_ start: Date, wake: Date) -> Double {
        let c = cal.dateComponents([.hour, .minute], from: start)
        let mins = Double(c.hour! * 60 + c.minute!)
        return cal.isDate(start, inSameDayAs: wake) ? mins + 720 : mins - 720
    }

    /// Daily statistics for a quantity type (sum or average), keyed by calendar day.
    static func daily(_ id: HKQuantityTypeIdentifier, unit: HKUnit, sum: Bool, days: Int) async -> [String: Double] {
        let type = HKQuantityType(id)
        let end = cal.startOfDay(for: Date()).addingTimeInterval(86400)
        let start = cal.date(byAdding: .day, value: -days, to: end)!
        let desc = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end)),
            options: sum ? .cumulativeSum : .discreteAverage,
            anchorDate: start,
            intervalComponents: DateComponents(day: 1))
        guard let coll = try? await desc.result(for: store) else { return [:] }
        var out: [String: Double] = [:]
        coll.enumerateStatistics(from: start, to: end) { st, _ in
            let q = sum ? st.sumQuantity() : st.averageQuantity()
            if let v = q?.doubleValue(for: unit), v > 0 { out[dayKey(st.startDate)] = v }
        }
        return out
    }

    /// Nights from sleep stages: asleep time only, overlaps from several sources merged.
    static func nights(days: Int) async -> [String: (min: Double, onset: Double)] {
        let start = cal.date(byAdding: .day, value: -days, to: Date())!
        let desc = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: HKQuery.predicateForSamples(withStart: start, end: Date()))],
            sortDescriptors: [SortDescriptor(\.startDate)])
        guard let samples = try? await desc.result(for: store) else { return [:] }
        let asleep = HKCategoryValueSleepAnalysis.allAsleepValues.map { $0.rawValue }
        var byWake: [String: [(Date, Date)]] = [:]
        for s in samples where asleep.contains(s.value) {
            let h = cal.component(.hour, from: s.endDate)
            let wake = h < 16 ? s.endDate : cal.date(byAdding: .day, value: 1, to: s.endDate)!
            byWake[dayKey(wake), default: []].append((s.startDate, s.endDate))
        }
        var out: [String: (Double, Double)] = [:]
        for (key, segs) in byWake {
            let sorted = segs.sorted { $0.0 < $1.0 }
            var total = 0.0; var cur: (Date, Date)? = nil
            for (a, b) in sorted {
                if let c = cur, a <= c.1 { cur = (c.0, max(c.1, b)) } else { if let c = cur { total += c.1.timeIntervalSince(c.0) }; cur = (a, b) }
            }
            if let c = cur { total += c.1.timeIntervalSince(c.0) }
            let mins = total / 60
            guard mins >= 60, let first = sorted.first?.0, let wakeDate = sorted.last?.1 else { continue }
            let wakeDay = cal.component(.hour, from: wakeDate) < 16 ? wakeDate : cal.date(byAdding: .day, value: 1, to: wakeDate)!
            out[key] = (mins, onsetOf(first, wake: wakeDay))
        }
        return out
    }

    /// Mood people log themselves in Apple Health (iOS 18 State of Mind). Valence -1...1 -> 1...5.
    static func moods(days: Int) async -> [String: Double] {
        guard #available(iOS 18.0, *) else { return [:] }
        let start = cal.date(byAdding: .day, value: -days, to: Date())!
        let desc = HKSampleQueryDescriptor(
            predicates: [.stateOfMind(HKQuery.predicateForSamples(withStart: start, end: Date()))],
            sortDescriptors: [])
        guard let samples = try? await desc.result(for: store) else { return [:] }
        var acc: [String: [Double]] = [:]
        for s in samples { acc[dayKey(s.startDate), default: []].append(3 + 2 * s.valence) }
        return acc.mapValues { $0.reduce(0, +) / Double($0.count) }
    }

    static func collect(days: Int) async -> [String: LueurDay] {
        async let steps = daily(.stepCount, unit: .count(), sum: true, days: days)
        async let rhr = daily(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), sum: false, days: days)
        async let hrv = daily(.heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), sum: false, days: days)
        async let sleep = nights(days: days)
        async let mood = moods(days: days)
        async let exercise = daily(.appleExerciseTime, unit: .minute(), sum: true, days: days)
        var light: [String: Double] = [:]
        if #available(iOS 17.0, *) { light = await daily(.timeInDaylight, unit: .minute(), sum: true, days: days) }
        var out: [String: LueurDay] = [:]
        for (k, v) in await steps { out[k, default: LueurDay()].steps = v }
        for (k, v) in await rhr { out[k, default: LueurDay()].restingHR = v }
        for (k, v) in await hrv { out[k, default: LueurDay()].hrv = v }
        for (k, v) in light { out[k, default: LueurDay()].daylight = v }
        for (k, v) in await exercise { out[k, default: LueurDay()].exercise = v }
        for (k, v) in await sleep { out[k, default: LueurDay()].sleepMin = v.min; out[k, default: LueurDay()].onset = v.onset }
        for (k, v) in await mood { out[k, default: LueurDay()].moodHealth = v }
        return out
    }
}

// MARK: - Background check (same rules as js/engine.js, sensor signals only)

enum LueurDrift {
    static func median(_ a: [Double]) -> Double { let s = a.sorted(); let m = s.count / 2; return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2 }

    static func shiftedCount(_ days: [String: LueurDay]) -> Int {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        func key(_ i: Int) -> String { LueurHealth.dayKey(cal.date(byAdding: .day, value: -i, to: today)!) }
        func irregular(_ i: Int) -> Double? {
            let v = (0..<7).compactMap { days[key(i + $0)]?.onset }
            guard v.count >= 4 else { return nil }
            let m = v.reduce(0, +) / Double(v.count)
            return (v.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(v.count)).squareRoot()
        }
        let signals: [(String, Double, (Int) -> Double?)] = [
            ("both", 25, { days[key($0)]?.sleepMin }),
            ("up", 25, { days[key($0)]?.onset }),
            ("up", 12, { irregular($0) }),
            ("down", 900, { days[key($0)]?.steps }),
            ("up", 2, { days[key($0)]?.restingHR }),
            ("down", 5, { days[key($0)]?.hrv }),
            ("down", 10, { days[key($0)]?.daylight }),
            ("down", 5, { days[key($0)]?.exercise }),
        ]
        var shifted = 0
        for (dir, floor, get) in signals {
            let base = (14..<42).compactMap(get)
            let recent = (0..<14).reversed().compactMap(get)
            guard base.count >= 10, recent.count >= 5 else { continue }
            let c = median(base)
            let sc = max(1.4826 * median(base.map { abs($0 - c) }), floor)
            func bad(_ z: Double) -> Double { dir == "up" ? z : dir == "down" ? -z : abs(z) }
            let off = recent.filter { bad(($0 - c) / sc) >= 1.5 }.count
            let zm = bad((median(Array(recent.suffix(7))) - c) / sc)
            if Double(off) / Double(recent.count) >= 0.6 && zm >= 1.2 { shifted += 1 }
        }
        return shifted
    }
}

enum LueurNotes {
    static let defaults = UserDefaults.standard

    /// Wakes the app when Health gets new sleep or steps, at most about daily.
    static func startBackgroundDelivery() {
        guard HKHealthStore.isHealthDataAvailable(), defaults.bool(forKey: "lueur.healthRequested") else { return }
        for type in [HKQuantityType(.stepCount), HKCategoryType(.sleepAnalysis)] as [HKSampleType] {
            let q = HKObserverQuery(sampleType: type, predicate: nil) { _, done, _ in
                Task { await check(); done() }
            }
            LueurHealth.store.execute(q)
            LueurHealth.store.enableBackgroundDelivery(for: type, frequency: .daily) { _, _ in }
        }
    }

    static func check() async {
        let today = LueurHealth.dayKey(Date())
        guard defaults.string(forKey: "lueur.lastCheck") != today, Calendar.current.component(.hour, from: Date()) >= 10 else { return }
        defaults.set(today, forKey: "lueur.lastCheck")
        if defaults.object(forKey: "lueur.notify") != nil && !defaults.bool(forKey: "lueur.notify") { return }
        if let s = defaults.string(forKey: "lueur.snoozeUntil"), s > today { return }
        if let last = defaults.object(forKey: "lueur.lastNotified") as? Date, Date().timeIntervalSince(last) < 7 * 86400 { return }
        let days = await LueurHealth.collect(days: 45)
        guard LueurDrift.shiftedCount(days) >= 2 else { return }
        show()
        defaults.set(Date(), forKey: "lueur.lastNotified")
    }

    static func show() {
        let c = UNMutableNotificationContent()
        c.title = "Your rhythm has shifted a little lately"
        c.body = "Have a look when you have a moment. Nothing is shared unless you choose to."
        c.interruptionLevel = .passive     // no sound, no banner: lands quietly in Notification Center
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "lueur.gentle", content: c, trigger: nil))
    }
}

// MARK: - Plugin

@objc(LueurHealthPlugin)
public class LueurHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LueurHealthPlugin"
    public let jsName = "LueurHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestHealth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPrefs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previewNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "debugSeed", returnType: CAPPluginReturnPromise),
    ]
    private let d = UserDefaults.standard

    private var isDebug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    @objc func status(_ call: CAPPluginCall) {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            let days = d.bool(forKey: "lueur.healthRequested") ? await LueurHealth.collect(days: 45) : [:]
            call.resolve([
                "platform": "ios",
                "health": HKHealthStore.isHealthDataAvailable() ? "available" : "unavailable",
                // iOS never tells apps which read permissions were granted; we only know we asked.
                "healthRequested": d.bool(forKey: "lueur.healthRequested"),
                "notifications": settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
                "debug": isDebug,
                "sensorShifts": LueurDrift.shiftedCount(days),
            ])
        }
    }

    @objc func requestHealth(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["granted": false, "reason": "unavailable"]); return }
        LueurHealth.store.requestAuthorization(toShare: [], read: LueurHealth.readTypes) { ok, err in
            if ok { self.d.set(true, forKey: "lueur.healthRequested"); LueurNotes.startBackgroundDelivery() }
            call.resolve(["granted": ok, "error": err?.localizedDescription ?? ""])
        }
    }

    @objc func requestNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { ok, _ in call.resolve(["granted": ok]) }
    }

    @objc func sync(_ call: CAPPluginCall) {
        let n = call.getInt("days") ?? 60
        Task {
            let days = await LueurHealth.collect(days: n)
            let arr: [[String: Any]] = days.keys.sorted().map { k in var o = days[k]!.json; o["date"] = k; return o }
            call.resolve(["days": arr])
        }
    }

    @objc func setPrefs(_ call: CAPPluginCall) {
        if let s = call.getString("snoozeUntil") { d.set(s, forKey: "lueur.snoozeUntil") }
        if let b = call.getBool("notify") { d.set(b, forKey: "lueur.notify") }
        call.resolve()
    }

    @objc func previewNotification(_ call: CAPPluginCall) { LueurNotes.show(); call.resolve() }

    @objc func wipe(_ call: CAPPluginCall) {
        for k in ["lueur.healthRequested", "lueur.snoozeUntil", "lueur.notify", "lueur.lastCheck", "lueur.lastNotified"] { d.removeObject(forKey: k) }
        call.resolve()
    }

    /// Debug builds only: writes six weeks of sample data into Health, with the "gradual shift" pattern.
    @objc func debugSeed(_ call: CAPPluginCall) {
        guard isDebug else { call.reject("Only available in debug builds"); return }
        // Exercise minutes and time in daylight are Apple Watch-only: HealthKit refuses app writes for them.
        var share: Set<HKSampleType> = [HKQuantityType(.stepCount), HKCategoryType(.sleepAnalysis), HKQuantityType(.restingHeartRate), HKQuantityType(.heartRateVariabilitySDNN)]
        if #available(iOS 18.0, *) { share.insert(HKSampleType.stateOfMindType()) }
        LueurHealth.store.requestAuthorization(toShare: share, read: LueurHealth.readTypes) { ok, _ in
            guard ok else { call.resolve(["seeded": 0]); return }
            self.d.set(true, forKey: "lueur.healthRequested")
            LueurHealth.store.save(Self.sampleData()) { saved, err in
                call.resolve(["seeded": saved ? 42 : 0, "error": err?.localizedDescription ?? ""])
            }
        }
    }

    private static func sampleData() -> [HKObject] {
        let cal = Calendar.current
        var g = SystemRandomNumberGenerator()
        func n() -> Double { (Double.random(in: 0..<1, using: &g) + Double.random(in: 0..<1, using: &g) + Double.random(in: 0..<1, using: &g) - 1.5) * 1.4 }
        var out: [HKObject] = []
        let today = cal.startOfDay(for: Date())
        for i in stride(from: 42, through: 1, by: -1) {
            let wake = cal.date(byAdding: .day, value: -i, to: today)!
            let p = i <= 21 ? min(1.0, Double(22 - i) / 12.0) : 0
            let weekend = cal.isDateInWeekend(wake)
            let onset = 23 * 60 + 20 + (weekend ? 35 : 0) + p * 85 + n() * (18 + p * 32)
            let sleep = max(200, 445 + (weekend ? 30 : 0) - p * 70 + n() * 24)
            let bed = cal.date(byAdding: .minute, value: Int(onset), to: cal.date(byAdding: .day, value: -1, to: wake)!)!
            let up = bed.addingTimeInterval(sleep * 60)
            out.append(HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: HKCategoryValueSleepAnalysis.asleepCore.rawValue, start: bed, end: up))
            let day0 = cal.date(bySettingHour: 9, minute: 0, second: 0, of: wake)!, day1 = cal.date(bySettingHour: 19, minute: 0, second: 0, of: wake)!
            let steps = max(300, (weekend ? 9400 : 8100) * (1 - p * 0.5) + n() * 1500)
            out.append(HKQuantitySample(type: HKQuantityType(.stepCount), quantity: HKQuantity(unit: .count(), doubleValue: steps.rounded()), start: day0, end: day1))
            let noon = cal.date(bySettingHour: 12, minute: 0, second: 0, of: wake)!
            out.append(HKQuantitySample(type: HKQuantityType(.restingHeartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 58 + p * 7 + n() * 2), start: noon, end: noon))
            out.append(HKQuantitySample(type: HKQuantityType(.heartRateVariabilitySDNN), quantity: HKQuantity(unit: .secondUnit(with: .milli), doubleValue: max(15, 48 - p * 14 + n() * 5)), start: up, end: up))
            if #available(iOS 18.0, *), i % 2 == 0 {
                let valence = max(-1, min(1, 0.35 - p * 0.7 + n() * 0.2))
                out.append(HKStateOfMind(date: day1, kind: .dailyMood, valence: valence, labels: [], associations: []))
            }
        }
        return out
    }
}
