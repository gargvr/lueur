import Foundation
import UIKit
import Capacitor
import CoreLocation
import CryptoKit
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
    var places: Double?; var homeStay: Double?; var rangeKm: Double?

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
        if let v = places { o["places"] = Int(v) }
        if let v = homeStay { o["homeStay"] = Int(v) }
        if let v = rangeKm { o["rangeKm"] = v }
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
        for (k, v) in LueurLocation.shared.days {
            out[k, default: LueurDay()].places = v["places"]; out[k, default: LueurDay()].homeStay = v["homeStay"]; out[k, default: LueurDay()].rangeKm = v["rangeKm"]
        }
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
            ("down", 0.7, { days[key($0)]?.places }),
            ("up", 5, { days[key($0)]?.homeStay }),
            ("down", 0.5, { days[key($0)]?.rangeKm }),
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
        CAPPluginMethod(name: "requestLocation", returnType: CAPPluginReturnPromise),
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
                "location": LueurLocation.shared.status == "always" || LueurLocation.shared.status == "whenInUse",
                "locationAlways": LueurLocation.shared.status == "always",
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

    @objc func requestLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let loc = LueurLocation.shared
            if loc.status == "always" { loc.start(); call.resolve(["granted": true]); return }
            if loc.status == "denied" {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                call.resolve(["granted": false, "needsSettings": true]); return
            }
            loc.onAuthChange = { loc.onAuthChange = nil; call.resolve(["granted": loc.status != "denied" && loc.status != "notDetermined", "status": loc.status]) }
            loc.request()
        }
    }

    @objc func previewNotification(_ call: CAPPluginCall) { LueurNotes.show(); call.resolve() }

    @objc func wipe(_ call: CAPPluginCall) {
        for k in ["lueur.healthRequested", "lueur.snoozeUntil", "lueur.notify", "lueur.lastCheck", "lueur.lastNotified"] { d.removeObject(forKey: k) }
        DispatchQueue.main.async { LueurLocation.shared.wipe() }
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
            Self.seedLocationDays()
            LueurHealth.store.save(Self.sampleData()) { saved, err in
                call.resolve(["seeded": saved ? 42 : 0, "error": err?.localizedDescription ?? ""])
            }
        }
    }

    /// Debug only: six weeks of daily location numbers with the same gradual shift.
    private static func seedLocationDays() {
        let cal = Calendar.current; var out: [String: [String: Double]] = [:]
        let today = cal.startOfDay(for: Date())
        for i in stride(from: 42, through: 1, by: -1) {
            let day = cal.date(byAdding: .day, value: -i, to: today)!
            let p = i <= 21 ? min(1.0, Double(22 - i) / 12.0) : 0
            let we = cal.isDateInWeekend(day)
            out[LueurHealth.dayKey(day)] = [
                "places": max(1, ((we ? 3.6 : 3.0) * (1 - p * 0.55) + Double.random(in: -0.9...0.9)).rounded()),
                "homeStay": min(98, (we ? 62 : 55) + p * 28 + Double.random(in: -6...6)).rounded(),
                "rangeKm": max(0.3, ((we ? 8.0 : 6.0) * (1 - p * 0.6) + Double.random(in: -1.2...1.2)) * 10).rounded() / 10,
            ]
        }
        UserDefaults.standard.set(out, forKey: "lueur.locDays")
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

// MARK: - Location (visits), reduced to three numbers a day


/// iOS tells us when you arrive at and leave a place ("visits") and about big moves, at very low
/// battery cost. Points are coarsened to ~110 m and kept only until their day is over; then each day
/// becomes: places (distinct spots), homeStay (% of the day at home), rangeKm (radius of gyration).
/// Home is kept only as a salted hash of a coarse cell, never as a place.
final class LueurLocation: NSObject, CLLocationManagerDelegate {
    static let shared = LueurLocation()
    private let lm = CLLocationManager()
    private let d = UserDefaults.standard
    var onAuthChange: (() -> Void)?

    override init() { super.init(); lm.delegate = self }

    var status: String {
        switch lm.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied, .restricted: return "denied"
        default: return "notDetermined"
        }
    }

    func request() {
        if lm.authorizationStatus == .notDetermined { lm.requestWhenInUseAuthorization() }
        else if lm.authorizationStatus == .authorizedWhenInUse { lm.requestAlwaysAuthorization() }
        start()
    }

    func start() {
        guard lm.authorizationStatus == .authorizedAlways || lm.authorizationStatus == .authorizedWhenInUse else { return }
        lm.desiredAccuracy = kCLLocationAccuracyHundredMeters
        lm.startMonitoringVisits()
        lm.startMonitoringSignificantLocationChanges()
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        if m.authorizationStatus == .authorizedWhenInUse { m.requestAlwaysAuthorization() }
        start(); onAuthChange?()
    }

    func locationManager(_ m: CLLocationManager, didVisit v: CLVisit) {
        let dep = v.departureDate == .distantFuture ? Date() : v.departureDate
        let arr = v.arrivalDate == .distantPast ? dep : v.arrivalDate
        append(lat: v.coordinate.latitude, lon: v.coordinate.longitude, from: arr, to: dep)
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        for l in locs { append(lat: l.coordinate.latitude, lon: l.coordinate.longitude, from: l.timestamp, to: l.timestamp) }
    }

    // MARK: storage

    private func salt() -> String {
        if let s = d.string(forKey: "lueur.locSalt") { return s }
        let s = UUID().uuidString; d.set(s, forKey: "lueur.locSalt"); return s
    }
    private func cell(_ lat: Double, _ lon: Double) -> String {
        let key = "\(salt()):\(String(format: "%.3f", lat)):\(String(format: "%.3f", lon))"
        return SHA256.hash(data: Data(key.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    private func append(lat: Double, lon: Double, from: Date, to: Date) {
        var pts = d.array(forKey: "lueur.locPoints") as? [[String: Any]] ?? []
        pts.append(["lat": (lat * 1000).rounded() / 1000, "lon": (lon * 1000).rounded() / 1000,
                    "a": from.timeIntervalSince1970, "b": to.timeIntervalSince1970, "c": cell(lat, lon)])
        d.set(pts, forKey: "lueur.locPoints")
        reduceFinishedDays()
    }

    /// Turns every finished day into three numbers and deletes its coordinates.
    func reduceFinishedDays() {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        var pts = d.array(forKey: "lueur.locPoints") as? [[String: Any]] ?? []
        var out = d.dictionary(forKey: "lueur.locDays") as? [String: [String: Double]] ?? [:]
        var votes = d.dictionary(forKey: "lueur.homeVotes") as? [String: Int] ?? [:]
        let byDay = Dictionary(grouping: pts) { cal.startOfDay(for: Date(timeIntervalSince1970: $0["b"] as! Double)) }
        for (day, list) in byDay where day < today {
            let dayEnd = day.addingTimeInterval(86400)
            // home = the cell most often occupied at 03:00
            let three = day.addingTimeInterval(3 * 3600)
            for p in list where (p["a"] as! Double) <= three.timeIntervalSince1970 && (p["b"] as! Double) >= three.timeIntervalSince1970 {
                votes[p["c"] as! String, default: 0] += 1
            }
            let home = votes.max { $0.value < $1.value }?.key
            var homeSecs = 0.0
            for p in list where p["c"] as? String == home {
                let a = max(p["a"] as! Double, day.timeIntervalSince1970), b = min(p["b"] as! Double, dayEnd.timeIntervalSince1970)
                if b > a { homeSecs += b - a }
            }
            let lats = list.map { $0["lat"] as! Double }, lons = list.map { $0["lon"] as! Double }
            let mLat = lats.reduce(0, +) / Double(lats.count), mLon = lons.reduce(0, +) / Double(lons.count)
            let kx = 111.32 * cos(mLat * .pi / 180)
            let rg = (zip(lats, lons).map { pow(($0.1 - mLon) * kx, 2) + pow(($0.0 - mLat) * 110.57, 2) }.reduce(0, +) / Double(lats.count)).squareRoot()
            var row: [String: Double] = ["places": Double(Set(list.map { $0["c"] as! String }).count), "rangeKm": (rg * 10).rounded() / 10]
            if home != nil { row["homeStay"] = (100 * homeSecs / 86400).rounded() }
            out[LueurHealth.dayKey(day)] = row
        }
        pts.removeAll { cal.startOfDay(for: Date(timeIntervalSince1970: $0["b"] as! Double)) < today }
        // keep about six months of daily numbers
        let keep = Set(out.keys.sorted().suffix(183))
        out = out.filter { keep.contains($0.key) }
        d.set(pts, forKey: "lueur.locPoints"); d.set(out, forKey: "lueur.locDays"); d.set(votes, forKey: "lueur.homeVotes")
    }

    var days: [String: [String: Double]] { reduceFinishedDays(); return d.dictionary(forKey: "lueur.locDays") as? [String: [String: Double]] ?? [:] }

    func wipe() {
        lm.stopMonitoringVisits(); lm.stopMonitoringSignificantLocationChanges()
        for k in ["lueur.locPoints", "lueur.locDays", "lueur.homeVotes", "lueur.locSalt"] { d.removeObject(forKey: k) }
    }
}
