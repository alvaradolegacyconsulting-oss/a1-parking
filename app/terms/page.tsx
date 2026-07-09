'use client'
import { useResolvedLogo } from '../lib/logo'
import { TOS_DISPLAY_DATE } from '../lib/legal-versions'

// Attorney finals — swapped 2026-07-09 keyed to '2026-07-08-v1'.
// Structure: intro (4 paragraphs; the 4th is bold body per attorney's
// heading-format fix — do NOT re-tag as a heading) → 27 numbered
// sections → Contact block with the STE 125 #270 PMB. Address stays
// verbatim (contract of record).
//
// Fidelity discipline ([[feedback_legal_version_pinning]] +
// post-swap fidelity gate): section count = 27; contact block address
// bytes = "9711 Mason Road, STE 125 #270". Any transcription-drift on
// the served copy = gate fail.

type Section = {
  n:  string
  title:  string
  intro?: React.ReactNode
  items?: React.ReactNode[]
  tail?:  React.ReactNode
}

const B = ({ children }: { children: React.ReactNode }) => (
  <strong style={{ color:'#e0e0e0' }}>{children}</strong>
)

const SECTIONS: Section[] = [
  { n:'1', title:'Definitions', items:[
    <><B>Approved Permit</B> means a parking permit, vehicle authorization, resident permit, guest permit, visitor pass, exemption, or similar permit, pass, approval, or authorization that is approved, issued, activated, maintained, processed, or otherwise made available through the Service for a vehicle, person, resident, guest, invitee, unit, Property, or account, whether temporary, recurring, permanent, exempt, active, or otherwise designated in the Service or applicable Pricing Schedule.</>,
    <><B>Authorized User</B> means an employee, consultant, contractor, agent, resident, tenant, guest, invitee, vehicle owner, or other individual authorized by Customer to access and use the Service or resident-facing or user-facing features under Customer's account.</>,
    <><B>Customer Data</B> means information, data, content, photos, records, messages, documents, vehicle information, tow-ticket information, property information, unit information, user information, billing quantities, and other materials submitted, uploaded, entered, transmitted, or otherwise made available through the Service by or on behalf of Customer or an Authorized User.</>,
    <><B>Documentation</B> means any user guides, support materials, online help files, specifications, or other documentation provided by ShieldMyLot for the Service.</>,
    <><B>Enforcement Track</B> means Service functionality, subscription plans, or workflows made available for towing companies, parking enforcement operators, non-consent tow workflows, tow-ticket generation, enforcement documentation, and related enforcement operations.</>,
    <><B>Pricing Schedule</B> means the then-current schedule of rates, pricing components, plan terms, usage metrics, billing bases, minimums, discounts, included quantities, overage charges, and related commercial terms for the Service, whether posted online, incorporated by reference, attached to an order form, presented at checkout, or otherwise made available by ShieldMyLot.</>,
    <><B>Property Management Track</B> or <B>PM Track</B> means Service functionality, subscription plans, or workflows made available for property managers, property owners, community operators, multifamily operators, homeowner associations, condominium associations, commercial property operators, or similar property-management users, whether or not those users also use enforcement-related functionality.</>,
    <><B>Property</B> means a single physical site, community, facility, building complex, parking facility, or managed location at one street address or commonly managed physical address. A Property may include multiple buildings, parking areas, amenities, phases, or related structures only if they are part of the same single physical site or community at the same address and are configured in the Service as one managed location. Separate street addresses, non-contiguous sites, separately managed communities, or separate facilities may not be combined into one Property merely to reduce fees.</>,
    <><B>Unit</B> means an individual residence, dwelling, apartment, condominium unit, townhome, rentable unit, door, suite, space, or other separately occupiable or separately assignable premises within or associated with a Property, whether occupied or vacant, and whether or not separately metered, leased, owned, or assigned.</>,
    <><B>Prohibited Use</B> means any use of the Service that violates these Terms, a Customer Agreement, applicable law, third-party rights, or the restrictions stated in Section 5.</>,
    <><B>ShieldMyLot IP</B> means the Service, Documentation, software, source code, object code, algorithms, models, workflows, user interfaces, designs, technology, know-how, analytics, aggregated statistics, feedback, trademarks, service marks, trade names, and other intellectual property owned or controlled by ShieldMyLot or its licensors.</>,
  ] },
  { n:'2', title:'Access to the Service', items:[
    <><B>Right to Use.</B> Subject to these Terms and any applicable Customer Agreement, ShieldMyLot grants Customer a limited, non-exclusive, non-transferable, non-sublicensable right to permit Authorized Users to access and use the Service during the applicable subscription term for Customer's internal business purposes and for resident-facing, tenant-facing, guest-facing, invitee-facing, or vehicle-related functions authorized by Customer.</>,
    <><B>Authorized Users.</B> Customer is responsible for identifying and authorizing its Authorized Users, assigning appropriate permissions, disabling access when no longer needed, and ensuring that Authorized Users comply with these Terms, the Customer Agreement, and applicable law.</>,
    <><B>Credentials.</B> Customer and Authorized Users are responsible for maintaining the confidentiality and security of usernames, passwords, access credentials, devices, and authentication methods. Customer is responsible for all activity under their account or credentials, whether authorized or unauthorized, except to the extent caused by ShieldMyLot's breach of its obligations.</>,
    <><B>Account Accuracy.</B> Customer and Authorized Users must provide accurate, current, and complete account, billing, licensing, authorization, classification, usage, and operational information and must promptly update such information, as necessary.</>,
    <><B>Business Use Only.</B> The Service may be used only for legitimate business, organizational, property-management, towing, parking enforcement, documentation, workflow automation, permit-management, resident-facing, guest-facing, invitee-facing, vehicle-registration, and related activities authorized by Customer. The Service is not offered as a standalone consumer service, but residents, tenants, guests, invitees, and vehicle owners may use features made available to them as Authorized Users under a Customer's account.</>,
  ] },
  { n:'3', title:'Customer Responsibilities', items:[
    'Customer is solely responsible for its towing, booting, parking-enforcement, gate-access, property-management, permit-management, resident-management, and related operational decisions and actions.',
    'Customer is solely responsible for obtaining and maintaining all licenses, permits, authorizations, insurance, property-owner approvals, parking-facility authorizations, signage, consents, notices, and other legal prerequisites required for its operations and use of the Service.',
    'Customer is responsible for complying with all applicable federal, state, and local laws, rules, regulations, ordinances, and industry requirements, including laws relating to towing, non-consent towing, parking enforcement, property authorization, consumer protection, privacy, data security, driver information, vehicle records, property management, resident information, permits, and transportation.',
    'Customer is responsible for the legality, accuracy, quality, and completeness of Customer Data and for verifying all Service outputs before relying on them.',
    'Customer must ensure that driver license numbers, tow-operator credentials, tow-company license information, license plate numbers, VINs, vehicle information, photos, property records, unit information, permit information, billing quantities, and tow-ticket information are collected, submitted, retained, used, and disclosed lawfully and accurately.',
  ] },
  { n:'4', title:'Customer Data', items:[
    <><B>Ownership.</B> As between ShieldMyLot and Customer, Customer retains ownership of Customer Data. Customer grants ShieldMyLot a non-exclusive, worldwide, royalty-free right to host, copy, process, transmit, display, disclose, and otherwise use Customer Data as necessary or appropriate to provide, operate, maintain, secure, support, and improve the Service; administer subscriptions and billing; verify usage quantities, Approved Permit counts, Property counts, and account classifications; perform obligations under these Terms and any Customer Agreement; comply with law; and as otherwise permitted by the Privacy Policy.</>,
    <><B>Authorization.</B> Customer represents and warrants that it has all rights, permissions, consents, authorizations, licenses, and lawful bases necessary to submit Customer Data to the Service and to authorize ShieldMyLot to process Customer Data as described in these Terms, the Privacy Policy, and any Customer Agreement.</>,
    <><B>No Sensitive Data Unless Required for the Service.</B> Customer may not submit sensitive personal information, regulated data, or confidential third-party information unless such submission is necessary for Customer's authorized use of the Service and Customer has legal authority to do so.</>,
    <><B>Service Outputs.</B> The Service may generate permits, tow tickets, records, reports, logs, recommendations, extracted plate text, vehicle attributes, workflow statuses, billing quantities, usage classifications, or other outputs based on Customer Data, third-party data, AI-assisted tools, or Customer configuration. Customer is responsible for reviewing and verifying all outputs before use.</>,
    <><B>Aggregated Statistics.</B> ShieldMyLot may collect and use aggregated, anonymized, or de-identified data and statistics relating to use, performance, operation, security, and improvement of the Service, provided that such information does not identify Customer, Customer's confidential information, any Authorized User, vehicle owner, driver, resident, unit occupant, or other individual.</>,
  ] },
  { n:'5', title:'Fees, Pricing Schedule, and Billing Metrics', items:[
    <><B>Pricing Schedule Controls Rates.</B> Customer will pay the fees stated in the applicable order form and the Pricing Schedule. The signed agreement, checkout page, or order form should identify the applicable plan, track, and Pricing Schedule, but actual rates, included quantities, minimums, and overage amounts may be stated in the Pricing Schedule rather than in the body of these Terms.</>,
    <><B>Flexible Billing Components.</B> Fees may be based on one or more billing components, including a base subscription fee, per-Property fees, per-Approved Permit fees, graduated Approved Permit tiers, per-user fees, usage-based fees, feature-based fees, minimum fees, overage fees, or any combination of the foregoing, as stated in the applicable order form, checkout page, Customer Agreement, or Pricing Schedule. Per-driver pricing is not a generally applicable billing component for the PM Track, Enforcement Track, or legacy tracks unless expressly stated in a signed Customer Agreement or applicable Pricing Schedule.</>,
    <><B>Property Management Track Pricing.</B> PM Track pricing may be metered by base subscription fee, Property count, Approved Permit count, feature package, usage level, graduated Approved Permit tiers, or any combination of those metrics. Customer acknowledges that ShieldMyLot may use a base fee plus per-Property fee plus graduated per-Approved Permit pricing model for PM Track customers to reflect the scale of a Customer's managed portfolio and permit activity.</>,
    <><B>Enforcement Track Unaffected Unless Stated.</B> A change to PM Track pricing, including adding, removing, or changing a per-Approved Permit component, does not by itself change Enforcement Track pricing unless the notice, order form, Pricing Schedule, or Customer Agreement expressly states that the change applies to Enforcement Track pricing.</>,
    <><B>No Single-Metric Pricing Commitment.</B> Unless a signed order form expressly states otherwise for a specified committed term, Customer is not entitled to pricing based solely on any single metric, and ShieldMyLot may price the PM Track using base, per-Property, per-Approved Permit, graduated usage, feature-based, or combined metrics in accordance with these Terms, the applicable Pricing Schedule, and the price-change notice provisions below.</>,
    <><B>Customer-Reported Quantities.</B> Customer must accurately report and maintain current information regarding Properties, Approved Permits, users, features, vehicles, account activity, and other billing quantities. Customer may not structure, combine, divide, name, configure, approve, suppress, delay, delete, reclassify, or otherwise manage Properties, Approved Permits, accounts, users, vehicles, or records in a manner designed to avoid, reduce, or misstate applicable fees.</>,
    <><B>Property Configuration Rule.</B> A Property must correspond to a single physical site or community at one address. Customer may not group multiple distinct communities, non-contiguous sites, separate addresses, separately managed locations, or unrelated facilities into one Property record for pricing purposes unless ShieldMyLot approves that configuration in writing.</>,
    <><B>Approved Permit Configuration Rule.</B> Approved Permit counts must include all permits, passes, approvals, exemptions, or authorizations included in the applicable Pricing Schedule or Customer Agreement, whether associated with residents, tenants, guests, invitees, vehicles, units, Properties, recurring vehicles, exempt plates, or other authorized users or vehicles, unless the applicable Pricing Schedule expressly excludes certain categories.</>,
    <><B>Taxes.</B> Customer is responsible for all taxes, duties, assessments, and similar governmental charges associated with Customer's purchases, excluding taxes based on ShieldMyLot's net income.</>,
    <><B>Non-Refundable Fees.</B> Except as expressly provided in the applicable Customer Agreement, order form, checkout terms, or written refund policy applicable to the subscription, fees are non-refundable and payable in U.S. dollars.</>,
  ] },
  { n:'6', title:'Pricing Changes, Notice, and Lock Periods', items:[
    <><B>Published Pricing Changes.</B> ShieldMyLot may update the Pricing Schedule from time to time, including by changing rates, adding or removing billing components, changing included quantities, adding per-Approved Permit pricing, changing Approved Permit tiers, changing Property-based pricing, adopting a base subscription plus per-Property and graduated per-Approved Permit model, changing minimum fees, or changing overage charges.</>,
    <><B>Notice Required.</B> Unless a signed Customer Agreement provides a longer period, ShieldMyLot will provide at least thirty days' prior notice for pricing changes applicable to monthly customers and at least sixty days' prior notice for pricing changes applicable to annual or longer-term customers.</>,
    <><B>Monthly Customer Lock.</B> For monthly customers, pricing changes will not take effect earlier than ninety days after the start of the customer's then-current paid subscription relationship or ninety days after the effective date of the last pricing change applicable to that customer, whichever is later, unless the change reduces fees or is required by law, tax, third-party provider requirement, or Customer's own change in usage, plan, quantities, features, Property count, Approved Permit count, or configuration.</>,
    <><B>Effective Date.</B> A pricing change becomes effective on the later of the date stated in the notice, the next renewal or billing period permitted by the applicable Customer Agreement, or the end of any required notice or lock period.</>,
    <><B>Billing Basis Changes Covered by Notice.</B> Customer agrees that a change in billing basis, including adding a per-Approved Permit component to PM Track pricing, changing Approved Permit tiers, replacing a prior billing metric with a base subscription plus per-Property and graduated per-Approved Permit structure, or adopting a hybrid base, per-Property, per-Approved Permit, feature-based, and usage-based structure, is a pricing change that may be implemented through an updated Pricing Schedule and notice under this Section, without a separate written amendment, unless a signed Customer Agreement expressly prohibits that type of change during a specified committed term.</>,
    <><B>Changes Requiring Amendment.</B> A separate written amendment is required only if ShieldMyLot seeks to change a term that the signed Customer Agreement expressly states is fixed and not subject to Pricing Schedule updates during the applicable committed term, or if ShieldMyLot seeks to change non-pricing legal terms that the signed Customer Agreement requires to be amended only by signed writing.</>,
    <><B>Customer Options After Notice.</B> If Customer does not agree to a pricing change, Customer may decline to renew, terminate at the end of the then-current billing period if permitted by the applicable Customer Agreement, or stop using the affected paid feature before the pricing change becomes effective. Continued use of the Service after the effective date constitutes acceptance of the updated Pricing Schedule.</>,
    <><B>Recommended Reference Language.</B> Each order form should state: "Customer's fees are determined by the then-current ShieldMyLot Pricing Schedule for the applicable Service track, plan, features, and usage quantities. The Pricing Schedule may include base subscription, per-Property, per-Approved Permit, graduated Approved Permit tier, per-user, feature-based, usage-based, minimum, and overage components, or any combination thereof. ShieldMyLot may update the Pricing Schedule, including rates and billing bases, upon notice in accordance with the Terms."</>,
  ] },
  { n:'7', title:'Audit, Verification, and Reclassification', items:[
    <><B>Verification Right.</B> ShieldMyLot may review Customer's account configuration, usage, Properties, Approved Permits, users, vehicles, features, workflows, permit activity, approvals, exemptions, and other billing quantities to verify accurate billing and proper account classification.</>,
    <><B>Customer Cooperation.</B> Customer must provide records, reports, portfolio summaries, property lists, Approved Permit records, permit activity logs, approval records, exemption records, vehicle authorization records, account configuration information, and other documentation reasonably requested by ShieldMyLot to verify billing quantities, track classification, and compliance with the Customer Agreement.</>,
    <><B>Reclassification.</B> If ShieldMyLot reasonably determines that Customer's actual usage, Properties, Approved Permits, features, business model, or configuration does not match Customer's represented plan, track, quantities, or classification, ShieldMyLot may reclassify the account, correct the applicable quantities, apply the appropriate Pricing Schedule, and invoice Customer for corrected fees.</>,
    <><B>Under-Reported Fees.</B> If Customer under-reported Properties, Approved Permits, users, features, usage, permit activity, account activity, or other billing quantities, ShieldMyLot may invoice Customer for underpaid amounts from the date the corrected quantities should have applied, plus any interest, collection costs, or audit costs permitted by the applicable Customer Agreement.</>,
    <><B>No Waiver.</B> ShieldMyLot's acceptance of a Customer's self-reported quantities, prior invoices, prior permit counts, prior Property counts, or prior account configuration does not waive ShieldMyLot's right to verify, audit, reclassify, or correct billing prospectively or retroactively as permitted by these Terms or a Customer Agreement.</>,
  ] },
  { n:'8', title:'Prohibited Uses', intro:'Customer and Authorized Users may not, directly, or indirectly:', items:[
    'Use the Service for any unlawful, fraudulent, deceptive, harassing, discriminatory, abusive, or unauthorized purpose.',
    'Use the Service to make or support towing, booting, parking-enforcement, gate-access, or property-enforcement decisions without required legal authority, property-owner authorization, signage, notice, license, permit, or other required prerequisite.',
    'Use the Service to obtain, attempt to obtain, disclose, resell, or use motor-vehicle-record information in violation of the Driver Privacy Protection Act, 18 U.S.C. §§ 2721–2725, any state equivalent law, or any applicable data-provider terms.',
    'Use license plate numbers, VINs, vehicle information, driver license numbers, tow-operator credentials, photos, or Service outputs for stalking, harassment, personal investigation, surveillance, retaliation, discrimination, or any unauthorized non-business purpose.',
    'Misrepresent, under-report, combine, divide, suppress, delay, delete, reclassify, or manipulate Properties, Approved Permits, permits, passes, approvals, exemptions, users, vehicles, features, usage, account activity, or account information to avoid or reduce fees.',
    'Upload, transmit, or store malicious code, malware, viruses, spyware, ransomware, or other harmful materials.',
    'Interfere with, disrupt, overload, scan, test, compromise, or attempt to gain unauthorized access to the Service, related systems, networks, accounts, or data.',
    'Reverse engineer, decompile, disassemble, decode, modify, copy, adapt, translate, or create derivative works of the Service, except to the extent such restriction is prohibited by applicable law.',
    'Rent, lease, lend, sell, resell, sublicense, distribute, publish, transfer, assign, or otherwise make the Service available to any third party except as expressly authorized by ShieldMyLot.',
    'Remove, obscure, or alter proprietary notices, trademarks, service marks, copyright notices, or other rights notices.',
    'Use the Service to develop, train, improve, or commercialize a competing product or service.',
    "Misrepresent Service functionality, outputs, compliance status, pricing classification, permit counts, or ShieldMyLot's role to property owners, vehicle owners, drivers, residents, regulators, courts, law enforcement, or other third parties.",
    'Use the Service in any manner that infringes, misappropriates, or violates intellectual property rights, privacy rights, publicity rights, contractual rights, or other rights of any person.',
  ] },
  { n:'9', title:'AI-Assisted License Plate Scanning', items:[
    <><B>Assistive Tool Only.</B> The Service may include AI-assisted computer-vision functionality designed to read license plate information from photos taken or uploaded by Authorized Users. This functionality is intended to reduce manual data entry and assist with workflow documentation.</>,
    <><B>No Automated Decision by ShieldMyLot.</B> ShieldMyLot does not make towing, booting, parking-enforcement, gate-access, legal-compliance, or other operational decisions. Customer and Authorized Users remain solely responsible for all decisions, actions, verification, legal compliance, and use of any plate information or Service output.</>,
    <><B>No Reliance Without Verification.</B> AI-assisted results may be inaccurate, incomplete, delayed, or unavailable. Customer and Authorized Users must verify extracted license plate information before relying on it or including it in a tow ticket, report, record, gate-access workflow, or enforcement action.</>,
    <><B>Image Retention.</B> Unless Customer separately uploads or retains a photo as part of a tow ticket, property record, evidence record, or other workflow, photos processed solely for AI-assisted license plate capture are used to extract plate information and are not retained by ShieldMyLot for independent image-storage purposes.</>,
  ] },
  { n:'10', title:'License Plate Recognition and Automated Gate Functionality', items:[
    <><B>Not Currently Included Unless Enabled.</B> License plate recognition (<B>&quot;LPR&quot;</B>) or automated gate-opening functionality is not part of the Service unless ShieldMyLot expressly makes it available in writing.</>,
    <><B>Future Terms.</B> If LPR or automated gate-opening functionality is offered in the future, ShieldMyLot may require additional terms, notices, configuration requirements, signage, data-retention settings, audit controls, security requirements, and customer certifications.</>,
    <><B>Customer Responsibility.</B> Customer is solely responsible for determining whether LPR, gate-opening, access-control, or similar functionality is lawful for Customer's properties, facilities, jurisdictions, and use cases, and for obtaining all required notices, consents, permissions, and approvals.</>,
  ] },
  { n:'11', title:'Plate and VIN Vehicle Lookup', items:[
    <><B>Feature Availability.</B> ShieldMyLot may make available a plate or VIN vehicle lookup feature that retrieves vehicle attributes such as year, make, model, VIN, and related non-owner vehicle information for tow-ticket automation and related workflows. This feature is not currently part of the Service unless expressly enabled by ShieldMyLot in writing.</>,
    <><B>Authorized Purpose.</B> Customer may use vehicle lookup functionality only for legitimate towing, parking-enforcement, tow-ticket generation, and related operational purposes authorized by ShieldMyLot and applicable law.</>,
    <><B>No Owner or Driver Lookup.</B> The vehicle lookup feature is not intended to retrieve or display owner names, driver names, home addresses, personal phone numbers, personal email addresses, Social Security numbers, photographs, disability information, medical information, or other personal information from state motor vehicle records.</>,
    <><B>Third-Party Data.</B> Third-party data sources or service providers may provide vehicle lookup information. ShieldMyLot does not guarantee the accuracy, completeness, availability, timeliness, legality for Customer's specific use, or continued availability of third-party vehicle data.</>,
    <><B>Verification Required.</B> Customer and Authorized Users must verify returned vehicle information before relying on it or including it in any tow ticket, legal record, enforcement record, customer communication, invoice, report, or other output.</>,
    <><B>Feature Suspension.</B> ShieldMyLot may suspend, limit, condition, or terminate access to vehicle lookup functionality if ShieldMyLot reasonably believes Customer or an Authorized User has used or may use the feature unlawfully, outside the authorized purpose, in violation of data-provider terms, or in a manner that creates legal, privacy, security, operational, or reputational risk.</>,
  ] },
  { n:'12', title:'DPPA and Motor Vehicle Records', items:[
    'Customer and Authorized Users must comply with the Driver Privacy Protection Act, 18 U.S.C. §§ 2721–2725, state motor-vehicle-record laws, data-provider terms, and all other applicable laws governing license plates, VINs, vehicle records, driver records, owner records, and related information.',
    'Customer may not use the Service to obtain, attempt to obtain, disclose, resell, or use personal information from motor vehicle records unless Customer has a lawful basis and the use is expressly authorized by applicable law and by ShieldMyLot.',
    "Customer must not use any license plate, VIN, vehicle lookup, or motor-vehicle-related feature to identify, locate, contact, surveil, profile, harass, or investigate any individual except where expressly permitted by applicable law and necessary for Customer's authorized business purpose.",
    "Customer must provide ShieldMyLot, upon request, information reasonably necessary to verify Customer's eligibility, licensing, authorization, permissible use, and compliance for vehicle-related features, including tow-company license information, operator information, state of operation, property authorization information, and data-use certifications.",
    'Customer will promptly notify ShieldMyLot of any suspected unauthorized access, misuse, unlawful use, complaint, regulatory inquiry, subpoena, litigation hold, or security incident involving license plates, VINs, vehicle lookup information, driver license numbers, motor-vehicle-record information, or Service outputs.',
  ] },
  { n:'13', title:'Intellectual Property', items:[
    <><B>ShieldMyLot Ownership.</B> ShieldMyLot and its licensors retain all right, title, and interest in and to the ShieldMyLot IP. No rights are granted except as expressly stated in these Terms or a Customer Agreement.</>,
    <><B>Feedback.</B> If Customer or an Authorized User provides ideas, suggestions, comments, improvements, requests, or other feedback regarding the Service (<B>&quot;Feedback&quot;</B>), ShieldMyLot may use the Feedback without restriction, attribution, or compensation. Customer assigns to ShieldMyLot all right, title, and interest in Feedback to the extent necessary for ShieldMyLot to use it freely.</>,
    <><B>Trademarks.</B> Customer may not use ShieldMyLot's names, trademarks, service marks, logos, or branding without ShieldMyLot's prior written consent.</>,
  ] },
  { n:'14', title:'Third-Party Services and Data Providers', items:[
    'The Service may interoperate with or rely on third-party hosting providers, payment processors, communications providers, analytics providers, AI-processing providers, vehicle-data providers, mapping providers, billing providers, or other third-party services.',
    "Third-party services may be subject to separate terms, privacy policies, availability limits, usage restrictions, fees, and data-handling requirements. Customer is responsible for complying with any third-party terms applicable to Customer's use.",
    'ShieldMyLot is not responsible for third-party services, third-party data, third-party downtime, third-party errors, or third-party changes, except to the extent expressly stated in a Customer Agreement.',
  ] },
  { n:'15', title:'Service Changes, Availability, and Support', items:[
    'ShieldMyLot may modify, update, enhance, discontinue, or remove features or functionality from time to time, subject to any commitments in an applicable Customer Agreement.',
    'ShieldMyLot will use commercially reasonable efforts to provide the Service and support in accordance with its then-current support practices or any applicable service-level plan.',
    'The Service may be unavailable due to maintenance, updates, outages, third-party service issues, security incidents, force majeure events, or other circumstances.',
    "ShieldMyLot is not responsible for Customer systems, internet connectivity, devices, Customer configurations, third-party services, or Customer's failure to follow Documentation or support instructions.",
  ] },
  { n:'16', title:'Suspension', intro:'ShieldMyLot may suspend, limit, or disable access to all or part of the Service if ShieldMyLot reasonably determines that:', items:[
    'Customer or an Authorized User has violated these Terms, a Customer Agreement, applicable law, or third-party terms.',
    "Customer's account poses a security, privacy, operational, legal, service-level, billing, or reputational risk.",
    'Customer or an Authorized User has used or attempted to use the Service for fraudulent, illegal, unauthorized, abusive, or Prohibited Use.',
    'Required fees remain unpaid.',
    'Customer refuses to provide information reasonably required to verify usage quantities, Approved Permit counts, Property counts, account classification, lawful use, or billing accuracy.',
    'A third-party provider suspends or terminates functionality required to provide the Service.',
    'Suspension is necessary to comply with law, legal process, government request, or data-provider requirement.',
  ], tail:"ShieldMyLot will use commercially reasonable efforts to provide notice of suspension when practicable and to restore access when the issue giving rise to suspension has been resolved to ShieldMyLot's reasonable satisfaction." },
  { n:'17', title:'Disclaimers', items:[
    <><B>Service Provided As Is.</B> To the maximum extent permitted by applicable law, the Service, Documentation, third-party services, third-party data, AI-assisted outputs, vehicle lookup outputs, billing outputs, reports, and other Service outputs are provided &quot;as is&quot; and &quot;as available,&quot; without warranties of any kind, whether express, implied, statutory, or otherwise.</>,
    <><B>No Implied Warranties.</B> ShieldMyLot disclaims all implied warranties, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, availability, security, and uninterrupted or error-free operation.</>,
    <><B>No Legal or Compliance Advice.</B> The Service is a technology platform and does not provide legal advice, compliance advice, towing authorization, property-owner authorization, regulatory approval, pricing advice, tax advice, or law-enforcement approval. Customer is solely responsible for consulting qualified counsel, tax advisors, and compliance professionals regarding Customer's obligations.</>,
    <><B>No Guarantee of Compliance.</B> ShieldMyLot does not warrant that Customer's use of the Service, any tow ticket, any permit, any vehicle lookup, any AI-assisted output, any billing classification, or any workflow will comply with applicable law, satisfy evidentiary requirements, support a tow or enforcement action, or meet any regulator's, court's, property owner's, vehicle owner's, resident's, or third party's requirements.</>,
    <><B>No Fail-Safe Use.</B> The Service is not designed for emergency, life-safety, fail-safe, or high-risk uses. Customer may not rely on the Service as the sole system for any safety-critical, emergency, legal-deadline, or irreversible operational decision.</>,
  ] },
  { n:'18', title:'Customer Indemnification', intro:"Customer will indemnify, defend, and hold harmless ShieldMyLot and its officers, directors, managers, members, employees, contractors, agents, licensors, service providers, successors, and assigns from and against all claims, demands, actions, investigations, losses, liabilities, damages, fines, penalties, costs, and expenses, including reasonable attorneys' fees, arising out of or relating to:", items:[
    'Customer Data.',
    "Customer's or any Authorized User's use of the Service or Service outputs.",
    "Customer's towing, booting, parking-enforcement, gate-access, property-management, permit-management, resident-management, or related decisions or actions.",
    "Customer's violation of these Terms, a Customer Agreement, applicable law, third-party rights, or third-party data-provider terms.",
    "Customer's failure to obtain or maintain required licenses, permits, authorizations, property-owner approvals, notices, consents, signage, insurance, or other legal prerequisites.",
    "Customer's use or misuse of license plate numbers, VINs, vehicle lookup information, driver license numbers, tow-operator credentials, motor-vehicle-record information, photos, property information, Unit information, resident information, permit information, or tow-ticket information.",
    "Customer's misrepresentation, under-reporting, manipulation, circumvention, or misclassification of Properties, Approved Permits, permits, passes, approvals, exemptions, users, vehicles, usage, features, account type, or other billing quantities.",
    "Customer's representations to third parties regarding ShieldMyLot, the Service, Service outputs, legal compliance, pricing classification, permit counts, or towing, enforcement, or property-management decisions.",
  ], tail:"ShieldMyLot may participate in the defense with counsel of its choice. Customer may not settle any claim in a manner that imposes liability, obligation, admission, or restriction on ShieldMyLot without ShieldMyLot's prior written consent." },
  { n:'19', title:'Limitation of Liability', items:[
    'To the maximum extent permitted by applicable law, ShieldMyLot will not be liable for any indirect, incidental, consequential, special, exemplary, enhanced, or punitive damages; lost profits; lost revenue; lost business; loss of goodwill; loss, corruption, interruption, delay, or recovery of data; business interruption; cost of substitute services; or reputational harm, whether based on contract, tort, negligence, strict liability, statute, or any other theory, even if ShieldMyLot has been advised of the possibility of such damages.',
    "To the maximum extent permitted by applicable law, ShieldMyLot's total aggregate liability arising out of or relating to these Terms, the Service, Service outputs, Customer Data, billing, pricing, or any Customer Agreement will not exceed the amounts paid by Customer to ShieldMyLot for the Service during the twelve months preceding the event giving rise to the claim, or one hundred dollars ($100) if no amounts were paid.",
    'The limitations in this Section apply to the maximum extent permitted by law and regardless of whether any remedy fails of its essential purpose.',
  ] },
  { n:'20', title:'Term and Termination', items:[
    'These Terms remain in effect while Customer or any Authorized User accesses or uses the Service.',
    'Subscription terms, renewals, and termination rights are governed by the applicable Customer Agreement or order form.',
    'ShieldMyLot may terminate or suspend access to the Service if Customer or an Authorized User violates these Terms, a Customer Agreement, applicable law, or third-party terms, or if ShieldMyLot reasonably determines that continued access creates legal, security, privacy, operational, billing, or reputational risk.',
    'Upon termination or expiration, Customer and Authorized Users must stop using the Service and Documentation. Sections that by their nature should survive termination will survive, including provisions relating to Customer Data, restrictions, intellectual property, fees owed, audit/reclassification, disclaimers, indemnification, limitation of liability, governing law, and dispute resolution.',
  ] },
  { n:'21', title:'Privacy', items:[
    "ShieldMyLot's collection, use, disclosure, retention, and protection of information are described in the ShieldMyLot Privacy Policy. Customer is responsible for providing any privacy notices, consents, disclosures, signage, policies, or other information required for Customer's operations and for Customer's collection, use, retention, and disclosure of Customer Data.",
  ] },
  { n:'22', title:'Confidentiality', items:[
    'Each party may receive non-public business, technical, financial, operational, pricing, usage, permit, or other confidential information from the other party. The receiving party may use confidential information only to exercise rights or perform obligations under these Terms or a Customer Agreement and must protect confidential information using reasonable care.',
    'The receiving party may disclose confidential information to its employees, contractors, service providers, professional advisors, or representatives who need to know the information and are bound by confidentiality obligations, or as required by law, legal process, or court order.',
    "Confidential information does not include information that is publicly available without breach, already known without confidentiality obligation, independently developed without use of the disclosing party's confidential information, or rightfully obtained from a third party without confidentiality obligation.",
  ] },
  { n:'23', title:'Export and Government Use', items:[
    'Customer must comply with all applicable export control, sanctions, and trade laws and may not use the Service in violation of such laws.',
    'The Service and Documentation are commercial computer software and commercial computer software documentation. Government users receive only those rights provided to other users under these Terms and any applicable Customer Agreement.',
  ] },
  { n:'24', title:'Changes to These Terms', items:[
    'ShieldMyLot may update these Terms from time to time by posting or otherwise making available an updated version.',
    'Changes are effective when posted or when otherwise stated in the updated Terms. Continued use of the Service after changes become effective constitutes acceptance of the updated Terms.',
    'If Customer has a signed Customer Agreement that specifies a different amendment process, that process controls for the signed Customer Agreement. Pricing Schedule changes are governed by Section 6 unless a signed Customer Agreement expressly states that a particular pricing term or billing basis may be changed only by signed amendment.',
  ] },
  { n:'25', title:'Governing Law and Dispute Resolution', items:[
    'These Terms are governed by the laws of the State of Texas, without regard to conflict-of-law rules.',
    'Any legal suit, action, or proceeding arising out of or relating to these Terms or the Service will be brought exclusively in the state or federal courts located in Houston, Texas and Harris County, Texas, and each party submits to the personal jurisdiction of those courts.',
    'To the maximum extent permitted by applicable law, each party may bring claims only in its individual capacity and not as a plaintiff or class member in any class, collective, consolidated, representative, or private attorney general action.',
  ] },
  { n:'26', title:'Miscellaneous', items:[
    <><B>Entire Agreement.</B> These Terms, the Privacy Policy, the applicable Pricing Schedule, and any applicable Customer Agreement constitute the agreement between the parties regarding the Service and supersede prior or contemporaneous understandings regarding their subject matter, except as otherwise stated in a signed Customer Agreement.</>,
    <><B>Order of Precedence.</B> If there is a conflict between these Terms and a signed Customer Agreement, the signed Customer Agreement controls to the extent of the conflict. If there is a conflict between a Pricing Schedule and an order form as to rates or committed quantities for a specified term, the order form controls for that specified term unless it expressly incorporates the later-updated Pricing Schedule.</>,
    <><B>Assignment.</B> Customer may not assign or transfer these Terms or any rights or obligations under them without ShieldMyLot's prior written consent, except as otherwise expressly permitted in a signed Customer Agreement. ShieldMyLot may assign these Terms in connection with a merger, acquisition, reorganization, financing, sale of assets, or by operation of law.</>,
    <><B>Severability.</B> If any provision of these Terms is held invalid, illegal, or unenforceable, the remaining provisions will remain in full force and effect, and the invalid provision will be modified to the minimum extent necessary to make it enforceable.</>,
    <><B>No Waiver.</B> Failure to enforce a provision is not a waiver of the right to enforce that provision later.</>,
    <><B>Force Majeure.</B> ShieldMyLot will not be liable for delay or failure to perform due to events beyond its reasonable control, including acts of God, natural disasters, epidemics, labor disputes, war, terrorism, civil unrest, government action, utility failures, internet failures, third-party service failures, or denial-of-service attacks.</>,
    <><B>Notices.</B> ShieldMyLot may provide notices through the Service, by email, by posting on its website, or by other reasonable means. Customer must send legal notices to ShieldMyLot at the address below unless a signed Customer Agreement states otherwise.</>,
  ] },
]

export default function Terms() {
  const logoUrl = useResolvedLogo()
  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'40px 20px' }}>
      <div style={{ maxWidth:'720px', margin:'0 auto' }}>

        <div style={{ textAlign:'center', marginBottom:'40px' }}>
          <img src={logoUrl} alt="ShieldMyLot"
            style={{ width:'64px', height:'64px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 16px' }} />
          <h1 style={{ color:'#C9A227', fontSize:'28px', fontWeight:'bold', margin:'0 0 8px' }}>ShieldMyLot Terms of Use</h1>
          <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Last Updated: {TOS_DISPLAY_DATE}</p>
        </div>

        {/* Intro paragraphs — 4 paragraphs, the 4th is BOLD BODY TEXT per
            attorney formatting fix (was mis-tagged as a Heading in the
            docx source and would have rendered in the blue heading style).
            Do NOT re-inherit heading style — this stays bold body. */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px', marginBottom:'20px' }}>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 14px' }}>
            These Terms of Use (<B>&quot;Terms&quot;</B>) govern access to and use of the ShieldMyLot website, software-as-a-service platform, mobile or web applications, documentation, support services, and related services (collectively, the <B>&quot;Service&quot;</B>) provided by <B>Alvarado Legacy Consulting, LLC</B>, a Texas limited liability company doing business as <B>ShieldMyLot</B> (<B>&quot;ShieldMyLot,&quot;</B> <B>&quot;Company,&quot;</B> <B>&quot;we,&quot;</B> <B>&quot;us,&quot;</B> or <B>&quot;our&quot;</B>).
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 14px' }}>
            The Service is a documentation and workflow platform for towing companies, parking enforcement operators, property managers, and related business users. The Service is intended for business and organizational use by Customers and their Authorized Users, and is not offered as a standalone personal, household, or consumer service. Individual residents, tenants, guests, invitees, or vehicle owners may access resident-facing or user-facing features only as Authorized Users under a Customer&apos;s account.
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 14px' }}>
            By accessing or using the Service, you agree to these Terms. If you access or use the Service on behalf of a company, organization, or other legal entity, you represent that you have authority to bind that entity, and &quot;Customer&quot; means that entity. If you do not agree to these Terms or do not have authority to bind the Customer, you may not access or use the Service.
          </p>
          <p style={{ color:'#e0e0e0', fontSize:'13px', lineHeight:'1.8', margin:'0', fontWeight:'bold' }}>
            These Terms apply in addition to any signed software-as-a-service agreement, order form, statement of work, service-level plan, data-processing addendum, pricing schedule, checkout terms, or other written agreement between ShieldMyLot and Customer (collectively, &quot;Customer Agreement&quot;). If there is a conflict between these Terms and a signed Customer Agreement, the signed Customer Agreement controls to the extent of the conflict.
          </p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px', marginBottom:'20px' }}>
          {SECTIONS.map(s => (
            <div key={s.n} style={{ marginBottom:'28px' }}>
              <h2 style={{ color:'#C9A227', fontSize:'15px', fontWeight:'bold', margin:'0 0 10px' }}>{s.n}. {s.title}</h2>
              {s.intro && <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 10px' }}>{s.intro}</p>}
              {s.items && s.items.map((it, i) => (
                <p key={i} style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 8px', paddingLeft:'18px', textIndent:'-18px' }}>
                  <span style={{ color:'#888', display:'inline-block', minWidth:'28px' }}>{s.n}.{i+1}.-</span> {it}
                </p>
              ))}
              {s.tail && <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'8px 0 0' }}>{s.tail}</p>}
            </div>
          ))}
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px', marginBottom:'20px' }}>
          <h2 style={{ color:'#C9A227', fontSize:'15px', fontWeight:'bold', margin:'0 0 10px' }}>27. Contact</h2>
          <p style={{ color:'#e0e0e0', fontSize:'13px', lineHeight:'1.8', margin:'0 0 4px', fontWeight:'bold' }}>Alvarado Legacy Consulting, LLC d/b/a ShieldMyLot</p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>9711 Mason Road, STE 125 #270</p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>Richmond, TX 77407</p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>Email: <a href="mailto:support@shieldmylot.com" style={{ color:'#C9A227', textDecoration:'none', fontWeight:'bold' }}>support@shieldmylot.com</a></p>
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'24px' }}>Alvarado Legacy Consulting LLC d/b/a ShieldMyLot</p>
      </div>
    </main>
  )
}
