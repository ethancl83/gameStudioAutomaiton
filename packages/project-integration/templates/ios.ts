import { createHash } from 'node:crypto';
import { CATALOG, marker, MAX_SDK_PLACEHOLDER } from '../catalog.js';
import { rewardedUnit } from '../ids.js';
import { ensurePlistKey } from '../patch.js';
import type { IntegrationFinding, PlannedFileChange, SdkCatalogEntry, TemplateContext, TemplatePlan } from '../types.js';

export function planIos(ctx: TemplateContext, existing: Map<string, string | null>): TemplatePlan {
  const findings: IntegrationFinding[] = [];
  const changes: PlannedFileChange[] = [];
  const catalog: SdkCatalogEntry[] = [];
  const ads = ctx.provider === 'admob' || ctx.provider === 'applovin-max';
  const iap = ctx.products.length > 0 || ctx.provider === 'app-store';

  let podfile = existing.get('Podfile');
  if (!podfile) {
    findings.push({
      code: 'format.podfile_missing',
      severity: 'error',
      message: 'Podfile이 없어 가짜 App 타깃을 만들지 않습니다. 실제 앱 타깃에 의존성을 연결할 수 없습니다.',
      path: 'Podfile',
      fixHint: 'Xcode/CocoaPods가 생성한 Podfile을 프로젝트 루트에 두세요.',
    });
    return { supported: false, catalog, changes, findings };
  }
  const pods: string[] = [];
  if (ctx.provider === 'admob') {
    catalog.push(CATALOG.admobIos, CATALOG.admobIosSpm);
    pods.push(`pod 'Google-Mobile-Ads-SDK', '${CATALOG.admobIos.version}'`);
  }
  if (ctx.provider === 'applovin-max') {
    catalog.push(CATALOG.maxIos);
    pods.push(`pod 'AppLovinSDK', '${CATALOG.maxIos.version}'`);
  }
  if (pods.length) {
    const mark = marker('ios-pods', 'hash');
    if (podfile.includes(mark.begin)) {
      const begin = podfile.indexOf(mark.begin);
      const end = podfile.indexOf(mark.end);
      if (end > begin) {
        podfile = `${podfile.slice(0, begin)}${mark.begin}\n  ${pods.join('\n  ')}\n  ${mark.end}${podfile.slice(end + mark.end.length)}`;
      }
    } else {
      const endIdx = podfile.lastIndexOf('end');
      if (endIdx < 0) {
        findings.push({
          code: 'format.podfile',
          severity: 'error',
          message: 'Podfile에서 target end를 찾지 못했습니다. 임의 형식을 덮어쓰지 않습니다.',
          path: 'Podfile',
        });
        return { supported: false, catalog, changes, findings };
      }
      podfile = `${podfile.slice(0, endIdx)}  ${mark.begin}\n  ${pods.join('\n  ')}\n  ${mark.end}\n${podfile.slice(endIdx)}`;
    }
    const existingPod = existing.get('Podfile');
    changes.push({
      path: 'Podfile',
      action: existingPod ? 'patch' : 'create',
      reason: '공식 CocoaPods 버전을 고정합니다.',
      content: podfile,
    });
  }

  const plistPath = [...existing.keys()].find((path) => path === 'Info.plist' || path.endsWith('/Info.plist')) ?? 'Info.plist';
  let plist = existing.get(plistPath);
  if (!plist) {
    plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n`;
  }
  if (ctx.provider === 'admob' && ctx.appId) {
    const m = marker('gad-app-id', 'xml');
    const next = ensurePlistKey(plist, 'GADApplicationIdentifier', ctx.appId, m.begin, m.end, findings, plistPath);
    if (next == null) return { supported: false, catalog, changes, findings };
    plist = next;
  }
  if (plist !== (existing.get(plistPath) ?? '')) {
    changes.push({
      path: plistPath,
      action: existing.get(plistPath) ? 'patch' : 'create',
      reason: '공식 Info.plist GADApplicationIdentifier를 추가합니다.',
      content: plist,
    });
  }

  if (ads) {
    if (!rewardedUnit(ctx.adUnits)) {
      findings.push({
        code: 'id.reward_unit_required',
        severity: 'error',
        message: 'iOS 보상형 브리지에는 adFormat=REWARD 단위가 필요합니다.',
      });
    } else {
      changes.push(iosAds(ctx));
    }
  }
  if (iap) {
    catalog.push(CATALOG.storeKit2);
    changes.push(iosStoreKit(ctx));
  }
  const swiftFiles = changes.filter((change) => change.path.endsWith('.swift')).map((change) => change.path);
  const pbxPath = [...existing.keys()].find((path) => path.endsWith('project.pbxproj'));
  if (swiftFiles.length) {
    if (!pbxPath || existing.get(pbxPath) == null) {
      findings.push({
        code: 'format.pbxproj',
        severity: 'error',
        message: 'Xcode project.pbxproj를 읽지 못해 Swift 파일을 타깃에 등록하지 않습니다. 소스만 두면 컴파일에 포함되지 않습니다.',
        path: pbxPath ?? 'project.pbxproj',
        fixHint: '표준 pbxproj가 있는 .xcodeproj를 프로젝트 루트에서 열고 미리보기 경로에 포함하세요.',
      });
    } else {
      const nextPbx = registerSwiftInPbx(existing.get(pbxPath)!, swiftFiles, findings, pbxPath);
      if (nextPbx == null) return { supported: false, catalog, changes, findings };
      if (nextPbx !== existing.get(pbxPath)) {
        changes.push({ path: pbxPath, action: 'patch', reason: 'Swift 브리지를 PBX Sources에 멱등 등록합니다.', content: nextPbx });
      }
    }
  }
  if (ctx.provider === 'applovin-max') {
    changes.push({
      path: 'AppOpsMonetization/MaxRuntime.plist',
      action: 'create',
      reason: 'MAX SDK Key 런타임 바인딩 플래그 (값은 없음)',
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>SDKKeyPlaceholder</key>\n  <string>${MAX_SDK_PLACEHOLDER}</string>\n  <key>SDKKeyBound</key>\n  <${ctx.maxSdkKeyBound ? 'true' : 'false'}/>\n  <key>PublicSdkKeyHook</key>\n  <string>MaxSdkKey.txt</string>\n</dict>\n</plist>\n`,
    });
    changes.push({
      path: 'AppOpsMonetization/MaxSdkKey.txt',
      action: 'create',
      reason: '공개 MAX SDK 키 스테이징 훅. 값은 비움.',
      content: '\n',
    });
  }
  return { supported: findings.every((item) => item.severity !== 'error'), catalog, changes, findings };
}

function iosAds(ctx: TemplateContext): PlannedFileChange {
  const unit = rewardedUnit(ctx.adUnits)!.adUnitId;
  if (ctx.provider === 'applovin-max') {
    return {
      path: 'AppOpsMonetization/AppOpsAds.swift',
      action: 'create',
      reason: 'MAX iOS initialize/show/reward 공식 API',
      content: `import AppLovinSDK
import UIKit

// APPOPS-INTEGRATION-BEGIN ios-max-bridge
// Official: https://support.applovin.com/en/max/ios/overview/integration
public final class AppOpsAds: NSObject, MARewardedAdDelegate {
    public static let rewardedAdUnitId = ${JSON.stringify(unit)}
    public static let sdkKeyPlaceholder = "«SDK-key»"
    public static let sdkKeyBound = ${ctx.maxSdkKeyBound ? 'true' : 'false'}
    private var rewarded: MARewardedAd?
    public static let shared = AppOpsAds()

    public func initialize(runtimeSdkKey: String? = nil) {
        let resolved = (runtimeSdkKey?.isEmpty == false ? runtimeSdkKey : loadPublicSdkKey())
        guard let sdkKey = resolved, !sdkKey.isEmpty else { return }
        let config = ALSdkInitializationConfiguration(sdkKey: sdkKey) { builder in
            builder.mediationProvider = ALMediationProvider.max
        }
        ALSdk.shared().initialize(with: config) { _ in }
    }

    func loadPublicSdkKey() -> String? {
        guard let url = Bundle.main.url(forResource: "MaxSdkKey", withExtension: "txt", subdirectory: "AppOpsMonetization")
            ?? Bundle.main.url(forResource: "MaxSdkKey", withExtension: "txt") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func loadRewarded() {
        let ad = MARewardedAd.shared(withAdUnitIdentifier: AppOpsAds.rewardedAdUnitId)
        ad.delegate = self
        ad.load()
        rewarded = ad
    }

    public func showRewarded() -> Bool {
        guard let ad = rewarded, ad.isReady else { return false }
        ad.show()
        return true
    }

    public func didRewardUser(for ad: MAAd, with reward: MAReward) {}
    public func didLoad(_ ad: MAAd) {}
    public func didFailToLoadAd(forAdUnitIdentifier adUnitIdentifier: String, withError error: MAError) {}
    public func didDisplay(_ ad: MAAd) {}
    public func didHide(_ ad: MAAd) { rewarded?.load() }
    public func didClick(_ ad: MAAd) {}
    public func didFail(toDisplay ad: MAAd, withError error: MAError) { rewarded?.load() }
}
// APPOPS-INTEGRATION-END ios-max-bridge
`,
    };
  }
  return {
    path: 'AppOpsMonetization/AppOpsAds.swift',
    action: 'create',
    reason: 'AdMob iOS MobileAds.shared.start / RewardedAd 공식 API',
    content: `import GoogleMobileAds
import UIKit

// APPOPS-INTEGRATION-BEGIN ios-admob-bridge
// Official: https://developers.google.com/admob/ios/quick-start
// Official rewarded: https://developers.google.com/admob/ios/rewarded
public final class AppOpsAds: NSObject {
    public static let appId = ${JSON.stringify(ctx.appId ?? '')}
    public static let rewardedAdUnitId = ${JSON.stringify(unit)}
    public static let shared = AppOpsAds()
    private var rewarded: RewardedAd?

    public func initialize() {
        MobileAds.shared.start()
    }

    public func loadRewarded() {
        RewardedAd.load(with: AppOpsAds.rewardedAdUnitId, request: Request()) { [weak self] ad, _ in
            self?.rewarded = ad
        }
    }

    public func showRewarded(from controller: UIViewController) -> Bool {
        guard let ad = rewarded else { return false }
        ad.present(from: controller) {
            let reward = ad.adReward
            _ = (reward.amount, reward.type)
        }
        return true
    }
}
// APPOPS-INTEGRATION-END ios-admob-bridge
`,
  };
}

function iosStoreKit(ctx: TemplateContext): PlannedFileChange {
  const ids = ctx.products.map((item) => JSON.stringify(item.productId)).join(', ');
  return {
    path: 'AppOpsMonetization/AppOpsStore.swift',
    action: 'create',
    reason: 'StoreKit 2 Product.products / purchase; finish only after CompleteVerifiedPurchase',
    content: `import StoreKit

public typealias VerificationRequired = (_ productId: String, _ purchaseToken: String, _ signedPayload: String) -> Void

// APPOPS-INTEGRATION-BEGIN ios-storekit2-bridge
// Official: https://developer.apple.com/documentation/storekit/product/purchase()
// Local JWS is StoreKit 2 authenticity. Server entitlement/duplicate handling is still required. Do not finish until verified.
@MainActor public enum AppOpsStore {
    public static let productIds: Set<String> = [${ids}]
    public static var verificationRequired: VerificationRequired?
    private static var transactionUpdatesTask: Task<Void, Never>?

    public static func startTransactionListener() {
        guard transactionUpdatesTask == nil else { return }
        transactionUpdatesTask = Task {
            for await result in Transaction.updates {
                if Task.isCancelled { return }
                guard case .verified(let transaction) = result else { continue }
                verificationRequired?(transaction.productID, String(transaction.id), result.jwsRepresentation)
            }
        }
    }

    public static func products() async throws -> [Product] {
        startTransactionListener()
        return try await Product.products(for: productIds)
    }

    public static func purchase(_ productId: String) async throws -> String? {
        guard let product = try await products().first(where: { $0.id == productId }) else { return nil }
        switch try await product.purchase() {
        case .success(let verification):
            switch verification {
            case .verified(let transaction):
                verificationRequired?(transaction.productID, String(transaction.id), verification.jwsRepresentation)
                return verification.jwsRepresentation
            case .unverified(_, _):
                return nil
            }
        case .userCancelled, .pending:
            return nil
        @unknown default:
            return nil
        }
    }

    public static func restore() async throws {
        startTransactionListener()
        try await AppStore.sync()
        for await result in Transaction.currentEntitlements {
            switch result {
            case .verified(let transaction):
                verificationRequired?(transaction.productID, String(transaction.id), result.jwsRepresentation)
            case .unverified(_, _):
                continue
            }
        }
    }

    public static func completeVerifiedPurchase(_ purchaseToken: String) async {
        for await result in Transaction.unfinished {
            if case .verified(let transaction) = result, String(transaction.id) == purchaseToken {
                await transaction.finish()
            }
        }
    }
}
// APPOPS-INTEGRATION-END ios-storekit2-bridge
`,
  };
}

function pbxId(seed: string): string {
  return createHash('sha1').update(`appops-pbx:${seed}`).digest('hex').slice(0, 24).toUpperCase();
}

function applicationSourcesPhaseId(source: string): string | null {
  const targetRe = /([A-F0-9]{24}) \/\* [^*]+ \*\/ = \{\s*isa = PBXNativeTarget;[\s\S]*?buildPhases = \(([\s\S]*?)\);[\s\S]*?productType = "([^"]+)";/g;
  const apps: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = targetRe.exec(source))) {
    if (match[3] !== 'com.apple.product-type.application') continue;
    const phaseIds = [...match[2].matchAll(/([A-F0-9]{24}) \/\* Sources \*\//g)].map((item) => item[1]);
    if (phaseIds[0]) apps.push(phaseIds[0]);
  }
  if (apps.length !== 1) return null;
  return apps[0];
}

export function registerSwiftInPbx(source: string, swiftPaths: string[], findings: IntegrationFinding[], path: string): string | null {
  if (!source.includes('Begin PBXFileReference section') || !source.includes('Begin PBXSourcesBuildPhase section') || !source.includes('Begin PBXBuildFile section') || !source.includes('PBXNativeTarget')) {
    findings.push({
      code: 'format.pbxproj',
      severity: 'error',
      message: 'project.pbxproj에 PBXNativeTarget/Sources 구간이 없어 등록하지 않습니다.',
      path,
      fixHint: 'Xcode가 생성한 표준 애플리케이션 pbxproj를 사용하세요.',
    });
    return null;
  }
  const phaseId = applicationSourcesPhaseId(source);
  if (!phaseId) {
    findings.push({
      code: 'format.pbxproj_ambiguous_target',
      severity: 'error',
      message: '애플리케이션 PBXNativeTarget이 하나가 아니어서 Swift를 등록하지 않습니다.',
      path,
      fixHint: '앱 타깃이 하나인 pbxproj를 사용하세요. 멀티 타깃은 수동으로 소스를 연결하세요.',
    });
    return null;
  }
  const phaseBlock = source.match(new RegExp(`${phaseId} \\/\\* Sources \\*\\/ = \\{[\\s\\S]*?isa = PBXSourcesBuildPhase;[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`));
  if (!phaseBlock) {
    findings.push({ code: 'format.pbxproj', severity: 'error', message: '애플리케이션 타깃의 Sources 빌드 페이즈를 찾지 못했습니다.', path });
    return null;
  }
  let next = source;
  for (const filePath of swiftPaths) {
    const name = filePath.split('/').pop()!;
    if (next.includes(`path = ${name};`) || next.includes(`path = ${filePath};`)) continue;
    const fileRef = pbxId(`ref:${filePath}`);
    const build = pbxId(`build:${filePath}`);
    const fileEntry = `\t\t${fileRef} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${filePath}; sourceTree = SOURCE_ROOT; };\n`;
    const buildEntry = `\t\t${build} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${name} */; };\n`;
    next = next.replace('/* End PBXFileReference section */', `${fileEntry}/* End PBXFileReference section */`);
    next = next.replace('/* End PBXBuildFile section */', `${buildEntry}/* End PBXBuildFile section */`);
    const phase = next.match(new RegExp(`${phaseId} \\/\\* Sources \\*\\/ = \\{[\\s\\S]*?files = \\(`));
    if (!phase) {
      findings.push({ code: 'format.pbxproj', severity: 'error', message: 'Sources files 목록을 갱신하지 못했습니다.', path });
      return null;
    }
    next = next.replace(phase[0], `${phase[0]}\n\t\t\t\t${build} /* ${name} in Sources */,`);
    const group = next.match(/isa = PBXGroup;[\s\S]*?children = \([\s\S]*?\);/);
    if (group && !group[0].includes(fileRef)) {
      const withChild = group[0].replace('children = (', `children = (\n\t\t\t\t${fileRef} /* ${name} */,`);
      next = next.replace(group[0], withChild);
    }
  }
  return next;
}

/** Minimal valid application pbxproj for demos. One App native target + Sources phase. */
export const MINIMAL_IOS_PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {
/* Begin PBXBuildFile section */
		A10000000000000000000001 /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10000000000000000000002 /* AppDelegate.swift */; };
/* End PBXBuildFile section */
/* Begin PBXFileReference section */
		A10000000000000000000002 /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };
		A10000000000000000000003 /* App.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = App.app; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */
/* Begin PBXGroup section */
		A10000000000000000000020 = {
			isa = PBXGroup;
			children = (
				A10000000000000000000002 /* AppDelegate.swift */,
				A10000000000000000000030 /* Products */,
			);
			sourceTree = "<group>";
		};
		A10000000000000000000030 /* Products */ = {
			isa = PBXGroup;
			children = (
				A10000000000000000000003 /* App.app */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */
/* Begin PBXNativeTarget section */
		A10000000000000000000040 /* App */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = A10000000000000000000070 /* Build configuration list for PBXNativeTarget "App" */;
			buildPhases = (
				A10000000000000000000050 /* Sources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = App;
			productName = App;
			productReference = A10000000000000000000003 /* App.app */;
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */
/* Begin PBXProject section */
		A10000000000000000000060 /* Project object */ = {
			isa = PBXProject;
			attributes = {
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
			};
			buildConfigurationList = A10000000000000000000080 /* Build configuration list for PBXProject "App" */;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = A10000000000000000000020;
			productRefGroup = A10000000000000000000030 /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				A10000000000000000000040 /* App */,
			);
		};
/* End PBXProject section */
/* Begin PBXSourcesBuildPhase section */
		A10000000000000000000050 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				A10000000000000000000001 /* AppDelegate.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */
/* Begin XCBuildConfiguration section */
		A10000000000000000000071 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGNING_ALLOWED = NO;
				GENERATE_INFOPLIST_FILE = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 15.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.AppOpsFixture;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SDKROOT = iphoneos;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		A10000000000000000000072 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGNING_ALLOWED = NO;
				GENERATE_INFOPLIST_FILE = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 15.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.AppOpsFixture;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SDKROOT = iphoneos;
				SWIFT_COMPILATION_MODE = wholemodule;
				SWIFT_OPTIMIZATION_LEVEL = "-O";
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
		A10000000000000000000081 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CLANG_ENABLE_MODULES = YES;
				SDKROOT = iphoneos;
			};
			name = Debug;
		};
		A10000000000000000000082 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CLANG_ENABLE_MODULES = YES;
				SDKROOT = iphoneos;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */
/* Begin XCConfigurationList section */
		A10000000000000000000070 /* Build configuration list for PBXNativeTarget "App" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				A10000000000000000000071 /* Debug */,
				A10000000000000000000072 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		A10000000000000000000080 /* Build configuration list for PBXProject "App" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				A10000000000000000000081 /* Debug */,
				A10000000000000000000082 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
	rootObject = A10000000000000000000060 /* Project object */;
}
`;
