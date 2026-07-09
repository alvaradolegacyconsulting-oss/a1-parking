'use client'
import { useResolvedLogo } from '../lib/logo'
import { PRIVACY_DISPLAY_DATE } from '../lib/legal-versions'

// Attorney finals — swapped 2026-07-09 keyed to '2026-07-08-v1'.
// Structure: 3 intro paragraphs → 17 numbered sections → Contact block
// (Section 18 IS the Contact block per the docx). Address stays
// verbatim: 9711 Mason Road, STE 125 #270 · Richmond, TX 77407.

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
  { n:'1', title:'Scope and Roles', items:[
    <><B>Business-to-Business Service.</B> The Service is provided to business and organizational customers, including towing companies, parking enforcement operators, property managers, property owners, associations, and related organizations (<B>&quot;Customers&quot;</B>). Individuals who access the Service through a Customer account, including residents, tenants, guests, invitees, and vehicle owners using resident-facing or user-facing features authorized by a Customer, are <B>&quot;Authorized Users&quot;</B>.</>,
    <><B>Customer Data.</B> Information submitted, uploaded, entered, transmitted, or otherwise made available through the Service by or on behalf of a Customer or Authorized User is <B>&quot;Customer Data&quot;</B>. Customer Data may include towing, parking-enforcement, property-management, property, unit, resident, permit, vehicle, ticket, user-account, operational, communications, billing, subscription, and related workflow information.</>,
    <><B>Customer Responsibility.</B> Customers determine what Customer Data is submitted to the Service and are responsible for the accuracy, legality, and authorization for that data. Customers are responsible for complying with applicable towing, parking enforcement, property-management, property authorization, privacy, notice, consent, licensing, and recordkeeping laws, including any laws governing their collection, use, disclosure, or retention of vehicle, driver, property, unit, permit, resident, or enforcement information.</>,
    <><B>ShieldMyLot&apos;s Role.</B> ShieldMyLot uses Customer Data to provide, maintain, secure, support, and improve the Service, administer subscriptions and billing, verify account configuration, property counts, permit activity, Approved Permit counts, and usage, and as otherwise described in this Privacy Policy, the applicable Terms of Use, and any signed agreement with the Customer.</>,
  ] },
  { n:'2', title:'Information We Collect', intro:'We may collect the following categories of information:', items:[
    <><B>Account and Administrative Information.</B> Names, business email addresses, phone numbers, usernames, passwords or authentication credentials, company name, business address, role/title, billing contact information, support contacts, and related account-administration information.</>,
    <><B>Authorized User Information.</B> Information about Authorized Users, which may include name, contact information, login credentials, user role, permissions, activity logs, assigned properties, assigned permits, assigned tickets, vehicle-registration information, and support interactions. Customers may also provide information relating to towing-company personnel, such as operator names, tow-company license information, driver license numbers, certification, or credential information, and similar operational or compliance information.</>,
    <><B>Property, Unit, and Parking-Enforcement Information.</B> Property names, property addresses, parking-facility details, property-owner or property-manager authorization information, parking rules, signage or authorization documentation, permits, passes, approvals, exemptions, permit activity, approved permit counts, tow tickets, incident records, photos, timestamps, locations, enforcement notes, workflow status information, and property-management configuration information. For property-management customers, this may include property counts, property addresses, community/site information, building or complex information, unit or door counts, unit identifiers, permit counts, Approved Permit counts, vehicle authorization records, and other information used to configure the Service, administer subscriptions, verify usage, or calculate fees.</>,
    <><B>Vehicle and Tow-Ticket Information.</B> License plate numbers, state of registration, vehicle identification numbers (<B>&quot;VINs&quot;</B>), year, make, model, color, permit or pass status, tow-ticket information, parking-violation or enforcement information, and related operational records.</>,
    <><B>Photos and Images.</B> Photos or images uploaded or captured by Customers or Authorized Users in connection with parking-enforcement, property documentation, towing workflows, permit-management workflows, or AI-assisted plate capture. As described below, ShieldMyLot&apos;s AI-assisted plate scanning is intended to read license plate information from photos for data-entry assistance and not to retain images for independent image-storage purposes unless the Customer separately uploads or stores photos as part of a tow ticket, property record, permit record, or other Service workflow.</>,
    <><B>Communications and Support Information.</B> Messages, emails, support tickets, call notes, feedback, troubleshooting information, training communications, and other interactions with ShieldMyLot.</>,
    <><B>Payment, Subscription, and Billing Information.</B> Subscription plan information, pricing schedule or plan selection, invoice information, payment status, billing address, tax information, reported usage quantities, property counts, permit counts, Approved Permit counts, vehicle authorization counts, account classifications, reclassification information, audit support information, and payment-related records. We may use third-party payment processors and generally do not store full payment-card numbers.</>,
    <><B>Usage, Device, and Technical Information.</B> Log data, IP address, browser type, device identifiers, operating system, pages, or screens viewed, referring pages, session information, feature usage, error reports, system events, authentication events, and security logs.</>,
    <><B>Cookies and Similar Technologies.</B> We may use cookies, pixels, local storage, session tokens, and similar technologies to operate the Service, maintain sessions, remember preferences, authenticate users, secure accounts, analyze usage, and improve performance.</>,
  ] },
  { n:'3', title:'AI-Assisted License Plate Scanning', items:[
    <><B>Purpose.</B> The Service may include AI-assisted computer-vision functionality that reads license plate numbers from photos taken or uploaded by Authorized Users. This feature is designed to reduce manual data entry and assist operators in capturing license plate information for tow-ticket, parking-enforcement, permit-management, or related workflow purposes.</>,
    <><B>No Automated Enforcement Decision by ShieldMyLot.</B> AI-assisted plate scanning is an assistive tool only. ShieldMyLot does not make towing, booting, parking-enforcement, gate-access, legal-compliance, permit-eligibility, or other operational decisions. Customers and Authorized Users remain solely responsible for reviewing, confirming, and lawfully using any plate information or other outputs generated through the Service.</>,
    <><B>Image Handling.</B> Unless a Customer separately chooses to upload or retain an image as part of a tow ticket, property record, permit record, evidence file, or other workflow, photos processed solely for AI-assisted license plate capture are used to extract license plate information and are not retained by ShieldMyLot for independent image-storage purposes.</>,
    <><B>Accuracy.</B> AI-assisted plate scanning may be inaccurate or incomplete due to image quality, lighting, obstruction, plate condition, jurisdictional plate design, user error, or other factors. Customers and Authorized Users must verify plate information before relying on it.</>,
  ] },
  { n:'4', title:'License Plate Recognition and Automated Gate Functionality', items:[
    <><B>Planned Functionality.</B> ShieldMyLot may in the future develop or offer license plate recognition (<B>&quot;LPR&quot;</B>) or automated gate-opening functionality. This functionality is not currently part of the Service unless expressly made available by ShieldMyLot in writing.</>,
    <><B>Additional Terms and Notices.</B> If ShieldMyLot offers LPR or automated gate-opening functionality in the future, additional notices, configuration requirements, customer obligations, and terms may apply, including requirements relating to signage, authorization, access control, audit logs, retention periods, and compliance with applicable privacy, security, parking, property, and transportation laws.</>,
  ] },
  { n:'5', title:'Plate and VIN Vehicle Lookup', items:[
    <><B>Planned or Future Feature.</B> ShieldMyLot may offer a vehicle lookup feature that allows Customers or Authorized Users to use a license plate number or VIN to retrieve vehicle information such as year, make, model, VIN, and related non-owner vehicle attributes for tow-ticket automation and workflow completion. This feature is not currently part of the Service unless expressly made available by ShieldMyLot in writing.</>,
    <><B>Permitted Operational Purpose.</B> If made available, vehicle lookup is intended to be used strictly by authorized towing or parking-enforcement business users for tow-ticket generation, parking-enforcement documentation, and related operational workflows.</>,
    <><B>No Owner or Driver Lookup.</B> ShieldMyLot does not intend for the vehicle lookup feature to obtain, display, disclose, or sell driver names, owner names, home addresses, personal phone numbers, personal email addresses, Social Security numbers, photographs, medical or disability information, or other personal information from state motor-vehicle records.</>,
    <><B>Data Source Disclosure.</B> Vehicle lookup information may be obtained from third-party data providers, public or commercially available vehicle-information sources, Customer-provided data, or other sources made available to the Service. Specific data sources may vary by feature, jurisdiction, provider, and availability.</>,
    <><B>Customer Verification.</B> Customers and Authorized Users are responsible for verifying any returned vehicle information before including it on a tow ticket or relying on it for any operational, compliance, or legal purpose.</>,
  ] },
  { n:'6', title:'Driver Privacy Protection Act Notice', items:[
    <><B>DPPA Background.</B> The federal Driver Privacy Protection Act (<B>&quot;DPPA&quot;</B>), 18 U.S.C. §§ 2721–2725, restricts the disclosure, obtaining, resale, and use of certain personal information from state motor vehicle records, subject to statutory exceptions.</>,
    <><B>Vehicle Attributes.</B> ShieldMyLot&apos;s contemplated plate/VIN lookup feature is designed to retrieve vehicle attributes such as year, make, model, and VIN for tow-ticket automation, and not to retrieve owner, driver, address, or other personal information from motor vehicle records.</>,
    <><B>No Circumvention.</B> Customers and Authorized Users may not use the Service to obtain, attempt to obtain, disclose, resell, or use motor-vehicle-record information in violation of the DPPA or any state equivalent law. Customers are responsible for ensuring that any use of license plate, VIN, tow-ticket, driver, vehicle, permit, or motor-vehicle-record data is permitted by applicable law and supported by any required authorization, license, consent, contract, or statutory exception.</>,
    <><B>Restricted Use.</B> If any Service feature accesses data that is subject to the DPPA or similar state law, Customers may use that feature only for the authorized business purpose for which ShieldMyLot makes it available and only in accordance with applicable law, provider terms, and any additional ShieldMyLot requirements.</>,
    <><B>Audit and Suspension.</B> ShieldMyLot may require Customers to provide information reasonably necessary to verify eligibility, licensing, authorization, or lawful use of DPPA-sensitive or vehicle-related features. ShieldMyLot may suspend or disable access to any feature where it reasonably believes the feature is being used unlawfully, outside the intended use case, or in a manner that creates legal, privacy, security, or reputational risk.</>,
  ] },
  { n:'7', title:'How We Use Information', intro:'We may use information for the following purposes:', items:[
    'To provide, operate, maintain, host, and support the Service.',
    'To create and manage Customer and Authorized User accounts, authentication, permissions, and access controls.',
    'To process Customer Data and generate workflow outputs, permits, tow tickets, documentation, reports, logs, and other Service records.',
    'To provide AI-assisted plate scanning, vehicle lookup, or other assistive workflow features when enabled.',
    'To administer subscriptions, pricing schedules, invoices, plan selections, property counts, permit counts, Approved Permit counts, account classifications, reclassifications, audits, and billing disputes.',
    'To communicate with Customers and Authorized Users about the Service, including account notices, support, updates, billing, pricing schedule changes, security alerts, and administrative messages.',
    'To troubleshoot, monitor, test, secure, improve, and develop the Service.',
    'To generate aggregated or de-identified statistics, analytics, benchmarking, performance data, and product insights that do not identify a Customer, Authorized User, property, vehicle owner, driver, resident, unit occupant, or other individual.',
    'To prevent, detect, investigate, or respond to fraud, misuse, under-reporting, misclassification, permit-count manipulation, security incidents, unauthorized access, illegal activity, policy violations, or service threats.',
    'To comply with legal obligations, enforce agreements, preserve legal rights, respond to lawful requests, and protect ShieldMyLot, Customers, Authorized Users, third parties, and the public.',
  ] },
  { n:'8', title:'How We Disclose Information', intro:'We may disclose information as follows:', items:[
    <><B>To Customers and Authorized Users.</B> We may make Customer Data available to the Customer and its Authorized Users according to account permissions, configurations, and Service functionality.</>,
    <><B>To Service Providers.</B> We may disclose information to vendors, hosting providers, cloud infrastructure providers, payment processors, analytics providers, security providers, customer-support providers, communications providers, AI-processing providers, vehicle-data providers, billing providers, audit-support providers, and other service providers that help us operate the Service.</>,
    <><B>To Complete Service Objectives.</B> We may disclose reports, outputs, permits, tow-ticket information, property records, or other Customer-directed information to third parties where reasonably necessary to complete Service objectives, support Customer workflows, or provide functionality requested or configured by the Customer.</>,
    <><B>Customer-Directed Disclosures.</B> Customers and Authorized Users may choose to export, share, send, publish, or otherwise disclose information from the Service. ShieldMyLot is not responsible for Customer-directed disclosures or for downstream use by recipients selected or authorized by a Customer or Authorized User.</>,
    <><B>Legal and Safety Disclosures.</B> We may disclose information if we believe disclosure is reasonably necessary to comply with law, subpoena, court order, government request, legal process, or law-enforcement request; to enforce agreements; to protect rights, property, safety, or security; or to investigate potential fraud, misuse, under-reporting, misclassification, permit-count manipulation, or unlawful activity.</>,
    <><B>Business Transfers.</B> We may disclose or transfer information in connection with a merger, acquisition, financing, reorganization, sale of assets, bankruptcy, or similar business transaction.</>,
    <><B>Aggregated or De-Identified Information.</B> We may disclose aggregated, anonymized, or de-identified information that does not identify a Customer, Authorized User, individual, property-specific confidential information, vehicle owner, driver, resident, unit occupant, or other person.</>,
  ] },
  { n:'9', title:'Cookies, Analytics, and Similar Technologies', items:[
    'We may use cookies and similar technologies to operate and secure the Service, authenticate sessions, remember preferences, analyze usage, improve performance, prevent fraud, and support functionality.',
    'Some browsers or devices may allow you to disable cookies. If you disable cookies, some Service features may not function properly.',
    <>The Service is not designed to respond to &quot;Do Not Track&quot; signals or similar browser-based signals.</>,
  ] },
  { n:'10', title:'Data Retention', items:[
    'We retain information for as long as reasonably necessary to provide the Service, comply with agreements, administer billing and subscription records, verify usage quantities, Approved Permit counts, maintain business records, resolve disputes, enforce rights, meet legal obligations, and support legitimate business purposes.',
    'Customer Data retention may depend on Customer configuration, subscription status, legal requirements, Service functionality, backup cycles, and operational needs.',
    'Photos processed solely for AI-assisted license plate capture are not retained for independent image-storage purposes unless the Customer separately uploads or retains them in the Service as part of a ticket, property record, permit record, evidence record, or other workflow.',
    'Backup copies, logs, and archival records may persist for a limited period after deletion from active systems, subject to technical and legal constraints.',
  ] },
  { n:'11', title:'Security', items:[
    'We use commercially reasonable administrative, technical, and organizational measures designed to protect information against unauthorized access, loss, misuse, alteration, or disclosure.',
    'No method of transmission, processing, hosting, or storage is completely secure. Customers and Authorized Users are responsible for maintaining the confidentiality of login credentials, using appropriate access controls, promptly disabling access for users who no longer require it, and notifying ShieldMyLot of suspected unauthorized access or security incidents.',
  ] },
  { n:'12', title:'Customer Compliance Responsibilities', items:[
    'Customers are responsible for ensuring that their use of the Service complies with applicable federal, state, and local laws, rules, regulations, ordinances, and contractual obligations.',
    'Customers are responsible for obtaining and maintaining all required towing-company licenses, operator licenses, property-owner authorizations, parking-enforcement authorizations, property-management authorizations, consents, notices, signage, insurance, and other permissions required for their operations and for their use of the Service.',
    'Customers are responsible for ensuring that driver license numbers, tow-operator credentials, vehicle information, plate numbers, VINs, photos, tow tickets, property records, unit information, permit information, billing quantities, and related information are accurate and are collected, uploaded, used, retained, and disclosed lawfully.',
    'Customers may not use the Service to harass, stalk, intimidate, discriminate against, surveil, or unlawfully identify any person, or to obtain vehicle, owner, driver, resident, occupant, or motor-vehicle-record information for an unauthorized purpose.',
  ] },
  { n:'13', title:'Privacy Rights and Choices', items:[
    <><B>Account Information.</B> Authorized Users may be able to update certain account information through the Service or by contacting their Customer administrator.</>,
    <><B>Customer-Controlled Data.</B> Many records in the Service are controlled by the Customer. Individuals seeking access, correction, deletion, or other action regarding Customer Data should contact the relevant Customer directly.</>,
    <><B>Requests to ShieldMyLot.</B> Where legally required or appropriate, ShieldMyLot may assist Customers in responding to privacy requests or may respond directly to requests relating to information for which ShieldMyLot is responsible. We may need to verify identity, authority, or the Customer relationship before acting on a request.</>,
    <><B>Marketing Communications.</B> If we send marketing emails, recipients may opt out by using the unsubscribe instructions in the email or by contacting us. Operational, transactional, legal, billing, pricing, account, and security communications may continue where necessary.</>,
    <><B>State Privacy Laws.</B> Depending on applicable law and the individual&apos;s location, certain individuals may have rights to access, correct, delete, port, or restrict certain personal information, or to opt out of certain processing. The availability and scope of these rights depend on applicable law, the nature of the information, and whether ShieldMyLot acts as a business/controller or service provider/processor for that information.</>,
  ] },
  { n:'14', title:'Children and Minors', items:[
    'The Service is intended for business users and is not directed to children or minors. We do not knowingly collect personal information from children under 13 through the Service. If we learn that we have collected personal information from a child in violation of applicable law, we will take appropriate steps to delete it.',
  ] },
  { n:'15', title:'International Use', items:[
    'The Service is intended for use in the United States unless otherwise agreed in writing. If information is accessed from outside the United States, users are responsible for ensuring that such access complies with applicable law. Information may be processed and stored in the United States or other locations where ShieldMyLot or its service providers operate.',
  ] },
  { n:'16', title:'Third-Party Services and Links', items:[
    'The Service may contain integrations, links, or connections to third-party websites, services, systems, data providers, or platforms. ShieldMyLot is not responsible for the privacy practices, security, content, or data-handling practices of third parties. Customers and Authorized Users should review applicable third-party terms and privacy notices.',
  ] },
  { n:'17', title:'Changes to this Privacy Policy', items:[
    <>We may update this Privacy Policy from time to time. The updated version will be indicated by an updated &quot;Last Updated&quot; date. Changes are effective when posted or otherwise made available unless a later effective date is stated. Continued use of the Service after an updated Privacy Policy becomes effective constitutes acknowledgment of the updated policy.</>,
  ] },
]

export default function Privacy() {
  const logoUrl = useResolvedLogo()
  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'40px 20px' }}>
      <div style={{ maxWidth:'720px', margin:'0 auto' }}>

        <div style={{ textAlign:'center', marginBottom:'40px' }}>
          <img src={logoUrl} alt="ShieldMyLot"
            style={{ width:'64px', height:'64px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 16px' }} />
          <h1 style={{ color:'#C9A227', fontSize:'28px', fontWeight:'bold', margin:'0 0 8px' }}>ShieldMyLot Privacy Policy</h1>
          <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Last Updated: {PRIVACY_DISPLAY_DATE}</p>
        </div>

        {/* 3 intro paragraphs */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px', marginBottom:'20px' }}>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 14px' }}>
            This Privacy Policy explains how <B>Alvarado Legacy Consulting, LLC</B>, a Texas limited liability company doing business as <B>ShieldMyLot</B> (<B>&quot;ShieldMyLot,&quot;</B> <B>&quot;Company,&quot;</B> <B>&quot;we,&quot;</B> <B>&quot;us,&quot;</B> or <B>&quot;our&quot;</B>), collects, uses, discloses, retains, and protects information in connection with the ShieldMyLot website, software-as-a-service platform, mobile or web applications, documentation, support services, and related services (collectively, the <B>&quot;Service&quot;</B>).
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 14px' }}>
            ShieldMyLot is a documentation and workflow platform for towing companies, parking enforcement operators, property managers, and related business users. The Service is intended for business use by authorized customers and their authorized users, and is not intended for personal, household, or consumer use.
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>
            By accessing or using the Service, you acknowledge that you have read and understand this Privacy Policy. If you use the Service on behalf of a company or other organization, that organization is responsible for ensuring that its authorized users and personnel comply with applicable law and with its own privacy, notice, consent, and data-handling obligations.
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
          <h2 style={{ color:'#C9A227', fontSize:'15px', fontWeight:'bold', margin:'0 0 10px' }}>18. Contact Us</h2>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 12px' }}>
            If you have questions about this Privacy Policy or ShieldMyLot&apos;s privacy practices, please contact us at:
          </p>
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
