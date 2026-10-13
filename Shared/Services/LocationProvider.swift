#if canImport(CoreLocation)
import CoreLocation

/// 单次定位。只在用户主动查询路线时请求一次，拿到即停，不做持续定位。
///
/// 放在 `Shared/Services/` 是因为 watchOS 也需要它 —— `CommuteService` 在手表上
/// 要自己拿出发地。与 iOS 侧 `iOS/WebHost.swift` 里的 `MainlineLocationProvider` 同构，
/// 但那个是 WebView 宿主专用的私有实现（由 JS 经桥调用），两者互不干扰：
/// iOS 的 WebView 路径仍走原实现，本类只服务原生直连高德的场景（Watch）。
@MainActor
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    static let shared = LocationProvider()

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocationCoordinate2D, Error>?
    private var timeout: Task<Void, Never>?

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// 返回 `经度,纬度`（WGS-84，**未经**坐标系转换）。
    /// 高德要 GCJ-02，调用方需再走一次 `assistant/coordinate/convert`。
    func gpsString() async throws -> String {
        let coordinate = try await current()
        return String(format: "%.6f,%.6f", coordinate.longitude, coordinate.latitude)
    }

    func current() async throws -> CLLocationCoordinate2D {
        guard continuation == nil else {
            throw CommuteError.originRequired("正在获取位置，请稍后重试。")
        }
        return try await withCheckedThrowingContinuation { pending in
            continuation = pending
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: 20 * 1_000_000_000) } catch { return }
                self?.finish(.failure(CommuteError.originRequired("定位超时，请选择出发地。")))
            }
            requestIfAuthorized()
        }
    }

    private func requestIfAuthorized() {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        case .denied, .restricted:
            finish(.failure(CommuteError.originRequired("定位权限未开启，请在设置中允许定位。")))
        @unknown default:
            finish(.failure(CommuteError.originRequired("无法获取位置。")))
        }
    }

    private func finish(_ result: Result<CLLocationCoordinate2D, Error>) {
        let pending = continuation
        continuation = nil
        timeout?.cancel()
        timeout = nil
        manager.stopUpdatingLocation()
        pending?.resume(with: result)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor [weak self] in self?.requestIfAuthorized() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        let coordinate = location.coordinate
        Task { @MainActor [weak self] in self?.finish(.success(coordinate)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.finish(.failure(CommuteError.originRequired("没有获取到当前位置，请选择出发地。")))
        }
    }
}
#endif
